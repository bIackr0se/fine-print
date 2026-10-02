/**
 * tool.call results exactly as Claude Code 2.1.286 recorded them
 * (demo/probe-shapes.md), with the paths shortened to /w.
 */
export const BASH_OK = (stdout: string) => ({
  ref: 1,
  result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  text: stdout || '(Bash completed with no output)',
  isReadOnly: true as const,
})

export const BASH_EXIT = (code: number, output = '') => ({
  ref: 1,
  result: `Error: Exit code ${code}${output ? '\n' + output : ''}`,
  text: `Exit code ${code}${output ? '\n' + output : ''}`,
  isError: true as const,
})

export const BASH_INTERRUPTED = {
  ref: 1,
  result: { stdout: '1 passed', stderr: '', interrupted: true, isImage: false, noOutputExpected: false },
  text: '1 passed',
}

export const WRITE_OK = (path: string) => ({
  ref: 1,
  result: { type: 'create', filePath: path, content: 'alpha\n', structuredPatch: [], originalFile: null, userModified: false },
  text: `File created successfully at: ${path}`,
})

export const EDIT_OK = (path: string) => ({
  ref: 1,
  result: { filePath: path, oldString: 'alpha', newString: 'beta', originalFile: 'alpha\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-alpha', '+beta'] }], userModified: false, replaceAll: false },
  text: `The file ${path} has been updated successfully.`,
})

export const EDIT_FAILED = {
  ref: 1,
  result: 'Error: String to replace not found in file.\nString: gamma',
  text: '<tool_use_error>String to replace not found in file.\nString: gamma</tool_use_error>',
  isError: true as const,
}

export const READ_OK = (path: string) => ({
  ref: 1,
  result: { type: 'text', file: { filePath: path, content: 'beta\n', numLines: 2, startLine: 1, totalLines: 2 } },
  text: '1\tbeta\n2\t',
  isReadOnly: true as const,
})

export const DENIED = { deny: 'Permission to use Bash has been denied.' }
