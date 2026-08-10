// Labeled eval cases for the classifier: realistic-shaped payloads with the
// tier/effort a correct classification should produce. See run-eval.js.
//
// Built from prompt banks per category rather than hand-typed one at a time --
// each bank is still real, readable prompts (not template noise), just grouped
// so 100 cases stay maintainable instead of 100 near-duplicate object literals.

// Length <=400, no code-ish keyword -> classifier's Haiku bucket.
const simplePrompts = [
  'Who is Virat Kohli', 'thanks, that worked', 'what time zone are you in',
  'how are you today', "what's the capital of France", 'good morning',
  'can you say that again', "what's 12 times 8", 'who won the champions league last year',
  "what's your name", 'ok sounds good', 'perfect, thank you',
  'when is Easter this year', 'whats the weather like generally in March',
  'who wrote Hamlet', 'how many continents are there', "what's the tallest mountain",
  'do you remember what I said earlier', 'sure go ahead', 'no worries',
  'yes please', 'whats a good name for a cat', 'how do I say hello in Spanish',
  "what's the boiling point of water", 'who is the president of France'
];

// Ordinary engineering asks -- deliberately avoid words that also appear in the
// classifier's high-complexity regex (refactor/debug/architecture/security/
// migration/concurrency/database/multi-file), or these would misclassify as Opus.
const standardPrompts = [
  'Write a function to format dates in JavaScript',
  'Fix the off-by-one error in this loop in utils.js',
  'Add a test for the login function',
  'Write a class that represents a shopping cart',
  'Import the lodash library and use it to sort this array',
  'Change this var to a const in script.js',
  'Build a small CLI tool that counts words in a file',
  'Write unit tests for this parser function',
  'Fix the typo in this error message',
  'Format this JSON file nicely',
  'Write a function that reverses a string',
  'Create a test suite for the calculator module',
  'Build a script to rename files in a folder',
  'Fix the broken import statement',
  'Write a class hierarchy for shapes',
  'Add input validation to this function',
  'Fix the failing test in test_math.py',
  'Write a helper function to debounce clicks',
  'Create a const object for app configuration',
  'Build a simple to-do list function',
  'Fix indentation in this code block',
  'Write a function to validate email addresses',
  'Add error handling to this function',
  'Fix this function so it returns the right value',
  'Write a class for a linked list'
];

// Long or keyword-flagged (architecture/refactor/security/migration/concurrency/
// database/multi-file/debug) -> classifier's Opus/high bucket.
const highPrompts = [
  'Review the architecture of this multi-file migration plan for concurrency and security issues: ' + 'x'.repeat(1600),
  'x'.repeat(1600),
  'Plan a database migration strategy for this schema',
  'Analyze this concurrency bug in the thread pool',
  'Design the security model for this multi-tenant system',
  'Refactor this monolith into a microservices architecture',
  'Debug this race condition in the scheduler',
  'Review this migration script for security holes',
  'Audit the authentication architecture for this service',
  'Investigate this database deadlock under concurrency',
  'Refactor the payment module without breaking existing security guarantees',
  'Design a zero-downtime database migration for this table',
  'Debug why this multi-file build is non-deterministic',
  'Review the concurrency model in this event loop implementation',
  'Plan the security review for this architecture change',
  'Migrate this database schema while preserving referential integrity',
  'Refactor this concurrency-sensitive cache invalidation logic',
  'Debug a security vulnerability reported in this multi-file diff',
  'Design the architecture for a distributed rate limiter',
  'Analyze the security implications of this database migration',
  'Refactor this service to remove a concurrency bottleneck',
  'Review the migration rollback plan for security regressions',
  'Debug this architecture-level deadlock between two services',
  'Plan a multi-file refactor of the authentication layer',
  'Investigate a concurrency issue affecting database write throughput'
];

function heavyTurn(toolName, resultText) {
  return {
    messages: [
      { role: 'user', content: 'Fix the bug in this file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: toolName, input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: resultText }] }
    ]
  };
}

const heavyTurnCases = [
  ['Read', 'file contents here'],
  ['Grep', 'match found on line 42'],
  ['Bash', 'command output: 0 exit code'],
  ['Edit', 'edit applied successfully'],
  ['Write', 'file written'],
  ['Glob', 'matched 3 files'],
  ['WebFetch', 'fetched page contents'],
  ['NotebookEdit', 'cell updated'],
  ['Read', 'binary file, cannot display'],
  ['Bash', 'error: command not found']
].map(([tool, text]) => heavyTurn(tool, text));

function build(prompts, category, tier, effort) {
  return prompts.map((content, i) => ({
    id: `${category}-${i + 1}`,
    category,
    expected_tier: tier,
    expected_effort: effort,
    payload: { messages: [{ role: 'user', content }] }
  }));
}

const edgeCases = [
  { id: 'edge-empty-messages', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [] } },
  { id: 'edge-last-message-assistant', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] } },
  { id: 'edge-code-keyword-but-short', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: 'can you fix this test' }] } },
  { id: 'edge-followup-after-tool-use-goes-back-simple', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [...heavyTurn('Read', 'file contents here').messages, { role: 'assistant', content: 'Fixed it.' }, { role: 'user', content: 'nice, who won the 2011 world cup' }] } },
  { id: 'edge-plain-text-block-array', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'quick question about the weather' }] }] } },
  { id: 'edge-whitespace-only', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: '   ' }] } },
  { id: 'edge-exactly-400-chars', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [{ role: 'user', content: 'a'.repeat(400) }] } },
  { id: 'edge-401-chars-no-keyword', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: 'a'.repeat(401) }] } },
  { id: 'edge-1500-chars-boundary', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: 'b '.repeat(750) }] } }, // 1500 chars exactly, no keyword -> not > 1500
  { id: 'edge-1501-chars-no-keyword', category: 'edge', expected_tier: 'opus', expected_effort: 'high', payload: { messages: [{ role: 'user', content: 'b'.repeat(1501) }] } },
  { id: 'edge-tool-result-then-nothing-else', category: 'edge', expected_tier: 'sonnet', expected_effort: 'high', payload: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] }] } },
  { id: 'edge-multiple-text-blocks', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }] }] } },
  { id: 'edge-mixed-code-and-file-keyword', category: 'edge', expected_tier: 'sonnet', expected_effort: 'medium', payload: { messages: [{ role: 'user', content: 'can you build this' }] } },
  { id: 'edge-question-mark-only', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [{ role: 'user', content: '?' }] } },
  { id: 'edge-emoji-only', category: 'edge', expected_tier: 'haiku', expected_effort: null, payload: { messages: [{ role: 'user', content: '👍' }] } }
];

module.exports = {
  cases: [
    ...build(simplePrompts, 'simple', 'haiku', null),
    ...build(standardPrompts, 'standard', 'sonnet', 'medium'),
    ...build(highPrompts, 'high', 'opus', 'high'),
    ...heavyTurnCases.map((payload, i) => ({ id: `heavy-turn-${i + 1}`, category: 'heavy-turn', expected_tier: 'sonnet', expected_effort: 'high', payload })),
    ...edgeCases
  ]
};
