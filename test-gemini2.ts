import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config({ path: './.env.local' });

async function run() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent('Say exactly: ok');
    console.log('SUCCESS:', result.response.text());
  } catch (err: any) {
    console.error('ERROR:', err.message);
  }
}

run();
