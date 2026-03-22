/** A self-contained eval fixture for testing lazy eval loading. */
export default {
  workflow: 'sample-wf',
  dataset: {
    name: 'sample-ds',
    getItems: async () => [{ input: { q: 'hello' } }, { input: { q: 'world' } }],
  },
  scorers: [
    {
      name: 'length-check',
      score: (output) => (String(output).length > 0 ? 1 : 0),
    },
  ],
};

export async function executeWorkflow(input) {
  return { output: `result for ${input.q}`, cost: 0.001 };
}
