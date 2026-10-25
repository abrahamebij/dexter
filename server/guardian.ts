import { main } from './runtime.js'

main().catch((error) => {
  console.error(`Guardian stopped: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  process.exitCode = 1
})
