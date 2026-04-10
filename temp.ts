import { generateContentWithBackoff } from './src/lib/gemini';

require('dotenv').config({ path: './.env.local' });

async function run() {
  try {
    const result = await generateContentWithBackoff('Respond ONLY with the JSON: { "test": 1 }');
    console.log(result.response.text());
  } catch (err: any) {
    console.error('FAILED:', err.message);
  }
}

run();
