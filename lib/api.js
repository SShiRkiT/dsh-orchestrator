/**
 * Public names, result kind and numeric limits, kept in one place so the tools,
 * the gate and the tests cannot drift apart.
 *
 * Dependency-free on purpose: importing this file must stay cheap and safe from
 * pure unit tests.
 */

export const DELEGATE_TOOL = 'delegate'
export const ORCHESTRATE_TOOL = 'orchestrate'

/**
 * Refusal message when a dispatch tool (`delegate` or `orchestrate`) is invoked
 * while dispatch mode (`config.enabled`) is turned off.
 */
export function disabledToolMessage(tool) {
  return `orchestrator: "${tool}" is disabled while dispatch mode is off. Execute the task directly with your regular tools instead of delegating.`
}

/** The `kind` field of the unified orchestration result. */
export const ORCHESTRATION_KIND = 'orchestration'

/**
 * Where a started child delivers its result. `delegate` answers the parent agent
 * (the existing behaviour); `orchestrate` answers its caller, because the tool
 * itself waits for the result.
 */
export const DELIVERY = Object.freeze({
  delegate: 'parent',
  orchestrate: 'caller',
})

export const LIMITS = Object.freeze({
  /** One item per worker at the start of the fan-out. */
  items: Object.freeze({ min: 1, max: 64 }),
  /** A pipeline stage is one worker call per item. */
  stages: Object.freeze({ min: 1, max: 8 }),
  maxConcurrency: Object.freeze({ min: 1, max: 16, default: 4 }),
  /** A larger serialized result is an explicit error, never a silent truncation. */
  serializedResultChars: 50000,
})
