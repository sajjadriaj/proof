// The argument grammar, kept beside the code rather than inside the executable so tests can
// check it against the usage text. Documentation that drifts from behaviour is a wrong claim
// in the place people read first.

export const GLOBAL_FLAGS = ['json']

export const COMMAND_FLAGS = {
  init: ['force', 'spec'],
  infer: ['write', 'depth', 'base', 'spec'],
  changed: ['depth', 'base', 'spec'],
  check: ['only', 'spec'],
  report: ['list', 'all', 'prune', 'keep'],
  guard: ['max-attempts', 'spec'],
}

/** Flags that consume the next argument. */
export const VALUE_FLAGS = new Set(['depth', 'base', 'only', 'spec', 'keep', 'max-attempts'])

/** How many bare arguments each command accepts. */
export const POSITIONALS = {
  init: { max: Infinity, usage: 'proof init "<requirement>"' },
  infer: { max: 0, usage: 'proof infer' },
  changed: { max: 0, usage: 'proof changed' },
  check: { max: 0, usage: 'proof check', hint: name => `did you mean --only "${name}"?` },
  report: { max: 1, usage: 'proof report [run]' },
  guard: { max: Infinity, usage: 'proof guard [--max-attempts N] -- <agent command...>' },
}

export const COMMANDS = Object.keys(COMMAND_FLAGS)
