import {Protocol} from "devtools-protocol"
import CDP = require("chrome-remote-interface")

import fs from "fs"
import path from "path"
import readline from "readline"
import {argv} from "yargs"
import chalk from "chalk"
import {Bar, Presets} from "cli-progress"

import {Box, State, create_baseline, load_baseline, diff_baseline, load_baseline_image} from "./baselines"
import {diff_image} from "./image"
import {platform} from "./sys"

const MAX_INT32 = 2147483647
export class Random {
  private seed: number

  constructor(seed: number) {
    this.seed = seed % MAX_INT32
    if (this.seed <= 0)
      this.seed += MAX_INT32 - 1
  }

  integer(): number {
    this.seed = (48271*this.seed) % MAX_INT32
    return this.seed
  }

  float(): number {
    return (this.integer() - 1) / (MAX_INT32 - 1)
  }
}

function shuffle<T>(array: T[], random: Random): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(random.float()*(i + 1))
    const temp = array[i]
    array[i] = array[j]
    array[j] = temp
  }
}

let rl: readline.Interface | undefined
if (process.platform == "win32") {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  rl.on("SIGINT", () => {
    process.emit("SIGINT", "SIGINT")
  })
}

process.on("SIGINT", () => {
  console.log()
  process.exit(130)
})

process.on("exit", () => {
  rl?.close()
})

const url = argv._[0] as string
const port = parseInt(argv.port as string | undefined ?? "9222")
const ref = (argv.ref ?? "HEAD") as string
const randomize = (argv.randomize ?? false) as boolean
const seed = argv.seed != null ? Number(argv.seed) : Date.now()

interface CallFrame {
  name: string
  url: string
  line: number
  col: number
}

interface Err {
  text: string
  url: string
  line: number
  col: number
  trace: CallFrame[]
}

class Exit extends Error {
  constructor(public code: number) {
    super(`exit: ${code}`)
  }
}

class TimeoutError extends Error {
  constructor() {
    super("timeout")
  }
}

function timeout(ms: number): Promise<void> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms)
    timer.unref()
  })
}

function encode(s: string): string {
  return s.replace(/[ \/\[\]]/g, "_")
}

type Suite = {description: string, suites: Suite[], tests: Test[]}
type Test = {description: string, skip: boolean, threshold?: number, retries?: number, dpr?: number}

type Result = {error: {str: string, stack?: string} | null, time: number, state?: State, bbox?: Box}

async function run_tests(): Promise<boolean> {
  let client
  let failure = false
  try {
    client = await CDP({port})
    const {Emulation, Network, Browser, Page, Runtime, Log, Performance} = client
    try {
      function collect_trace(stackTrace: Protocol.Runtime.StackTrace): CallFrame[] {
        return stackTrace.callFrames.map(({functionName, url, lineNumber, columnNumber}) => {
          return {name: functionName ? functionName : "(anonymous)", url, line: lineNumber+1, col: columnNumber+1}
        })
      }

      function handle_exception(exceptionDetails: Protocol.Runtime.ExceptionDetails): Err {
        const {text, exception, url, lineNumber, columnNumber, stackTrace} = exceptionDetails
        return {
          text: exception != null && exception.description != null ? exception.description : text,
          url: url ?? "(inline)",
          line: lineNumber+1,
          col: columnNumber+1,
          trace: stackTrace ? collect_trace(stackTrace) : [],
        }
      }

      type LogEntry = {level: "warning" | "error", text: string}

      let entries: LogEntry[] = []
      let exceptions: Err[] = []

      Runtime.consoleAPICalled(({type, args}) => {
        if (type == "warning" || type == "error") {
          const text = args.map(({value}) => value ? value.toString() : "").join(" ")
          entries.push({level: type, text})
        }
      })

      Log.entryAdded(({entry}) => {
        const {level, text} = entry
        if (level == "warning" || level == "error") {
          entries.push({level, text})
        }
      })

      Runtime.exceptionThrown(({exceptionDetails}) => {
        exceptions.push(handle_exception(exceptionDetails))
      })

      function fail(msg: string, code: number = 1): never {
        console.log(msg)
        throw new Exit(code)
      }

      // type Nominal<T, Name> = T & {[Symbol.species]: Name}

      class Value<T> {
        constructor(public value: T) {}
      }
      class Failure {
        constructor(public text: string) {}
      }
      class Timeout {}

      async function with_timeout<T>(promise: Promise<T>, wait: number): Promise<T | Timeout> {
        try {
          return await Promise.race([promise, timeout(wait)]) as T
        } catch (err) {
          if (err instanceof TimeoutError) {
            return new Timeout()
          } else {
            throw err
          }
        }
      }

      async function evaluate<T>(expression: string, timeout: number = 10000): Promise<Value<T> | Failure | Timeout> {
        const output = await with_timeout(Runtime.evaluate({expression, returnByValue: true, awaitPromise: true}), timeout)
        if (output instanceof Timeout) {
          return output
        } else {
          const {result, exceptionDetails} = output
          if (exceptionDetails == null)
            return new Value(result.value)
          else {
            const {text} = handle_exception(exceptionDetails)
            return new Failure(text)
          }
        }
      }

      async function is_ready(): Promise<boolean> {
        const expr = "typeof Bokeh !== 'undefined'"
        const result = await evaluate<boolean>(expr)
        return result instanceof Value && result.value
      }

      await Network.enable()
      await Network.setCacheDisabled({cacheDisabled: true})

      await Page.enable()
      await Page.navigate({url: "about:blank"})

      await Runtime.enable()
      await Log.enable()
      await Performance.enable({timeDomain: "timeTicks"})

      async function override_metrics(dpr: number = 1): Promise<void> {
        await Emulation.setDeviceMetricsOverride({
          width: 2000,
          height: 4000,
          deviceScaleFactor: dpr,
          mobile: false,
        })
      }

      override_metrics()

      await Browser.grantPermissions({
        permissions: ["clipboardReadWrite"],
      })

      const {errorText} = await Page.navigate({url})

      if (errorText != null) {
        fail(errorText)
      }

      if (exceptions.length != 0) {
        for (const exc of exceptions) {
          console.log(exc.text)
        }

        fail(`failed to load ${url}`)
      }

      await Page.loadEventFired()
      await evaluate("preload_fonts()")

      const ready = await is_ready()
      if (!ready) {
        fail(`failed to render ${url}`)
      }

      const result = await evaluate<Suite>("Tests.top_level")
      if (!(result instanceof Value)) {
        // TODO: Failure.text
        const reason = result instanceof Failure ? result.text : "timeout"
        fail(`internal error: failed to collect tests: ${reason}`)
      }

      const top_level = result.value

      type Status = {
        success?: boolean
        failure?: boolean
        timeout?: boolean
        skipped?: boolean
        errors: string[]
        baseline_name?: string
        baseline?: string
        baseline_diff?: string
        reference?: Buffer
        image?: Buffer
        image_diff?: Buffer
      }

      type TestItem = [Suite[], Test, Status]

      function* iter({suites, tests}: Suite, parents: Suite[] = []): Iterable<TestItem> {
        for (const suite of suites) {
          yield* iter(suite, parents.concat(suite))
        }

        for (const test of tests) {
          yield [parents, test, {errors: []}]
        }
      }

      function descriptions(suites: Suite[], test: Test): string[] {
        return [...suites, test].map((obj) => obj.description)
      }

      function description(suites: Suite[], test: Test, sep: string = " "): string {
        return descriptions(suites, test).join(sep)
      }

      const all_tests = [...iter(top_level)]
      const test_suite = all_tests

      if (randomize) {
        const random = new Random(seed)
        console.log(`randomizing with seed ${seed}`)
        shuffle(test_suite, random)
      }

      if (argv.k != null || argv.grep != null) {
        if (argv.k != null) {
          const keywords: string[] = Array.isArray(argv.k) ? argv.k : [argv.k]
          for (const [suites, test] of test_suite) {
            if (!keywords.some((keyword) => description(suites, test).includes(keyword))) {
              test.skip = true
            }
          }
        }

        if (argv.grep != null) {
          const regexes = (() => {
            const arr = Array.isArray(argv.grep) ? argv.grep : [argv.grep]
            return arr.map((str) => new RegExp(str as string))
          })()
          for (const [suites, test] of test_suite) {
            if (!regexes.some((regex) => description(suites, test).match(regex) != null)) {
              test.skip = true
            }
          }
        }
      }

      if (test_suite.length == 0) {
        fail("nothing to test")
      }

      if (!test_suite.some(([, test]) => !test.skip)) {
        fail("nothing to test because all tests were skipped")
      }

      const progress = new Bar({
        format: "{bar} {percentage}% | {value} of {total}{failures}{skipped}",
        stream: process.stdout,
        noTTYOutput: true,
        notTTYSchedule: 1000,
      }, Presets.shades_classic)

      const baselines_root = (argv.baselinesRoot as string | undefined) ?? null
      const baseline_names = new Set<string>()

      let skipped = 0
      let failures = 0

      function to_seq(suites: Suite[], test: Test): [number[], number] {
        let current = top_level
        const si = []
        for (const suite of suites) {
          si.push(current.suites.indexOf(suite))
          current = suite
        }
        const ti = current.tests.indexOf(test)
        return [si, ti]
      }

      function state(): object {
        function format(value: number, single: string, plural?: string): string {
          if (value == 0)
            return ""
          else if (value == 1)
            return ` | 1 ${single}`
          else
            return ` | ${value} ${plural ?? single}`
        }
        return {
          failures: format(failures, "failure", "failures"),
          skipped: format(skipped, "skipped"),
        }
      }

      progress.start(test_suite.length, 0, state())

      type MetricKeys = "JSEventListeners" | "Nodes" | "Resources" | "LayoutCount" | "RecalcStyleCount" | "JSHeapUsedSize" | "JSHeapTotalSize"
      const metrics: {[key in MetricKeys]: number[]} = {
        JSEventListeners: [],
        Nodes: [],
        Resources: [],
        LayoutCount: [],
        RecalcStyleCount: [],
        JSHeapUsedSize: [],
        JSHeapTotalSize: [],
      }

      async function add_datapoint(): Promise<void> {
        if (baselines_root == null)
          return
        const data = await Performance.getMetrics()
        for (const {name, value} of data.metrics) {
          switch (name) {
            case "JSEventListeners":
            case "Nodes":
            case "Resources":
            case "LayoutCount":
            case "RecalcStyleCount":
            case "JSHeapUsedSize":
            case "JSHeapTotalSize":
              metrics[name].push(value)
          }
        }
      }

      await add_datapoint()

      const out_stream = await (async () => {
        if (baselines_root != null) {
          const report_out = path.join(baselines_root, platform, "report.out")
          await fs.promises.writeFile(report_out, "")

          const stream = fs.createWriteStream(report_out, {flags: "a"})
          stream.write(`Tests report output generated on ${new Date().toISOString()}:\n`)
          return stream
        } else
          return null
      })()

      function format_output(test_case: TestItem): string | null {
        const [suites, test, status] = test_case

        if ((status.failure ?? false) || (status.timeout ?? false)) {
          const output = []

          let depth = 0
          for (const suite of [...suites, test]) {
            const is_last = depth == suites.length
            const prefix = depth == 0 ? chalk.red("\u2717") : `${" ".repeat(depth)}\u2514${is_last ? "\u2500" : "\u252c"}\u2500`
            output.push(`${prefix} ${suite.description}`)
            depth++
          }

          for (const error of status.errors) {
            output.push(error)
          }

          return output.join("\n")
        } else {
          return null
        }
      }

      function append_report_out(test_case: TestItem): void {
        if (out_stream != null) {
          const output = format_output(test_case)
          if (output != null) {
            out_stream.write("\n")
            out_stream.write(output)
            out_stream.write("\n")
          }
        }
      }

      try {
        for (const test_case of test_suite) {
          const [suites, test, status] = test_case

          entries = []
          exceptions = []

          const baseline_name = encode(description(suites, test, "__"))
          status.baseline_name = baseline_name

          if (baseline_names.has(baseline_name)) {
            status.errors.push("duplicated description")
            status.failure = true
          } else {
            baseline_names.add(baseline_name)
          }

          if (test.skip) {
            status.skipped = true
          } else {
            async function run_test(attempt: number | null, status: Status): Promise<boolean> {
              let may_retry = false
              const seq = JSON.stringify(to_seq(suites, test))
              const output = await (async () => {
                if (test.dpr != null)
                  override_metrics(test.dpr)
                try {
                  return await evaluate<Result>(`Tests.run(${seq})`)
                } finally {
                  if (test.dpr != null)
                    override_metrics()
                }
              })()
              await add_datapoint()
              try {
                const errors = entries.filter((entry) => entry.level == "error")
                if (errors.length != 0) {
                  status.errors.push(...errors.map((entry) => entry.text))
                  // status.failure = true // XXX: too chatty right now
                }

                if (exceptions.length != 0) {
                  status.errors.push(...exceptions.map((exc) => exc.text))
                  status.failure = true // XXX: too chatty right now
                }

                if (output instanceof Failure) {
                  status.errors.push(output.text)
                  status.failure = true
                } else if (output instanceof Timeout) {
                  status.errors.push("timeout")
                  status.timeout = true
                } else {
                  const result = output.value

                  if (result.error != null) {
                    const {str, stack} = result.error
                    status.errors.push(stack ?? str)
                    status.failure = true
                  }

                  if (baselines_root != null) {
                    const baseline_path = path.join(baselines_root, platform, baseline_name)

                    const {state: state_early} = result
                    if (state_early == null) {
                      status.errors.push("state not present in output")
                      status.failure = true
                    } else {
                      const output = await evaluate<State | null>(`Tests.get_state(${seq})`)
                      if (!(output instanceof Value) || output.value == null) {
                        status.errors.push("state not present in output")
                        status.failure = true
                      } else {
                        const state = output.value

                        await (async () => {
                          const baseline_early = create_baseline([state_early])
                          const baseline = create_baseline([state])

                          // This shouldn't happen, but sometimes does, especially in
                          // interactive tests. This needs to be resolved earlier, but
                          // at least the state will be consistent with images.
                          if (baseline_early != baseline) {
                            status.errors.push("inconsistent state")
                            status.errors.push("early:", baseline_early)
                            status.errors.push("later:", baseline)
                            status.failure = true
                            return
                          }

                          const baseline_file = `${baseline_path}.blf`
                          await fs.promises.writeFile(baseline_file, baseline)
                          status.baseline = baseline

                          const existing = load_baseline(baseline_file, ref)
                          if (existing != baseline) {
                            if (existing == null) {
                              status.errors.push("missing baseline")
                            } else {
                              if (test.retries != null)
                                may_retry = true
                            }
                            const diff = diff_baseline(baseline_file, ref)
                            status.failure = true
                            status.baseline_diff = diff
                            status.errors.push(diff)
                          }
                        })()
                      }
                    }

                    await (async () => {
                      const {bbox} = result
                      if (bbox != null) {
                        const image = await Page.captureScreenshot({format: "png", clip: {...bbox, scale: 1}})
                        const current = Buffer.from(image.data, "base64")
                        status.image = current

                        const image_file = `${baseline_path}.png`
                        const write_image = async () => fs.promises.writeFile(image_file, current)
                        const existing = load_baseline_image(image_file, ref)

                        switch (argv.screenshot) {
                          case undefined:
                          case "test":
                            if (existing == null) {
                              status.failure = true
                              status.errors.push("missing baseline image")
                              await write_image()
                            } else {
                              status.reference = existing

                              if (!existing.equals(current)) {
                                const diff_result = diff_image(existing, current)
                                if (diff_result != null) {
                                  may_retry = true
                                  const {diff, pixels, percent} = diff_result
                                  const threshold = test.threshold ?? 0
                                  if (pixels > threshold) {
                                    await write_image()
                                    status.failure = true
                                    status.image_diff = diff
                                    status.errors.push(`images differ by ${pixels}px (${percent.toFixed(2)}%)${attempt != null ? ` (attempt=${attempt})` : ""}`)
                                  }
                                }
                              }
                            }
                            break
                          case "save":
                            await write_image()
                            break
                          case "skip":
                            break
                          default:
                            throw new Error(`invalid argument --screenshot=${argv.screenshot}`)
                        }
                      }
                    })()
                  }
                }
              } finally {
                const output = await evaluate(`Tests.clear(${seq})`)
                if (output instanceof Failure) {
                  status.errors.push(output.text)
                  status.failure = true
                }
              }

              return may_retry
            }

            const do_retry = await run_test(null, status)
            if ((argv.retry || test.retries != null) && do_retry) {
              const retries = test.retries ?? 10

              for (let i = 0; i < retries; i++) {
                const do_retry = await run_test(i, status)
                if (!do_retry)
                  break
              }
            }
          }

          if (status.skipped ?? false)
            skipped++
          if ((status.failure ?? false) || (status.timeout ?? false))
            failures++

          append_report_out(test_case)
          progress.increment(1, state())
        }
      } finally {
        progress.stop()
      }

      if (out_stream) {
        out_stream.write("\n")
        out_stream.write(`Tests finished on ${new Date().toISOString()} with ${failures} failures.\n`)
        out_stream.end()
      }

      for (const test_case of test_suite) {
        const output = format_output(test_case)
        if (output != null) {
          console.log("")
          console.log(output)
        }
      }

      if (baselines_root != null) {
        const results = test_suite.map(([suites, test, status]) => {
          const {failure, image, image_diff, reference} = status
          return [descriptions(suites, test), {failure, image, image_diff, reference}]
        })
        const json = JSON.stringify({results, metrics}, (_key, value) => {
          if (value?.type == "Buffer")
            return Buffer.from(value.data).toString("base64")
          else
            return value
        })
        await fs.promises.writeFile(path.join(baselines_root, platform, "report.json"), json)

        const files = new Set(await fs.promises.readdir(path.join(baselines_root, platform)))
        files.delete("report.json")
        files.delete("report.out")

        for (const name of baseline_names) {
          files.delete(`${name}.blf`)
          files.delete(`${name}.png`)
        }

        if (files.size != 0) {
          fail(`there are outdated baselines:\n${[...files].join("\n")}`)
        }
      }

      if (failures != 0) {
        throw new Exit(1)
      }
    } finally {
      await Runtime.discardConsoleEntries()
    }
  } catch (error) {
    failure = true
    if (!(error instanceof Exit)) {
      const msg = error instanceof Error && error.stack != null ? error.stack : error
      console.error(`INTERNAL ERROR: ${msg}`)
    }
  } finally {
    if (client) {
      await client.close()
    }
  }

  return !failure
}

async function get_version(): Promise<{browser: string, protocol: string}> {
  const version = await CDP.Version({port})
  return {
    browser: version.Browser,
    protocol: version["Protocol-Version"],
  }
}

const chromium_min_version = 107

async function check_version(version: string): Promise<boolean> {
  const match = version.match(/Chrome\/(?<major>\d+)\.(\d+)\.(\d+)\.(\d+)/)
  const major = parseInt(match?.groups?.major ?? "0")
  const ok = chromium_min_version <= major
  if (!ok)
    console.error(`${chalk.red("failed:")} ${version} is not supported, minimum supported version is ${chalk.magenta(chromium_min_version)}`)
  return ok
}

async function run(): Promise<void> {
  const {browser, protocol} = await get_version()
  console.log(`Running in ${chalk.cyan(browser)} using devtools protocol ${chalk.cyan(protocol)}`)
  const ok0 = await check_version(browser)
  const ok1 = !argv.info ? await run_tests() : true
  process.exit(ok0 && ok1 ? 0 : 1)
}

async function main(): Promise<void> {
  try {
    await run()
  } catch (e) {
    console.log(`CRITICAL ERROR: ${e}`)
    process.exit(1)
  }
}

main()
