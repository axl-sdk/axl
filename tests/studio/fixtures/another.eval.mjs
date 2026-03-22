/** Second eval fixture — tests that multiple files are discovered. */
export default {
  workflow: 'another-wf',
  dataset: {
    name: 'another-ds',
    getItems: async () => [{ input: { text: 'test' } }],
  },
  scorers: [
    {
      name: 'always-pass',
      score: () => 1,
    },
  ],
};

export async function executeWorkflow(input) {
  return { output: input.text.toUpperCase(), cost: 0 };
}
