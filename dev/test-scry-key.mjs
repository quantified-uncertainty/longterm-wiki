#!/usr/bin/env node
import { config } from 'dotenv';
config({ path: '.env' });

const key = process.env.SCRY_API_KEY;
if (!key) {
  console.log('SCRY_API_KEY NOT set in environment after loading .env');
  process.exit(1);
}
console.log(`SCRY_API_KEY loaded: length=${key.length}, prefix=${key.slice(0, 6)}...`);

const sql = `SELECT title, uri FROM scry.search('anthropic', 'mv_eaforum_posts') WHERE title IS NOT NULL AND kind = 'post' LIMIT 1`;

const res = await fetch('https://api.scry.io/v1/scry/query', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'text/plain',
  },
  body: sql,
});

const body = await res.text();
console.log(`HTTP ${res.status}`);
console.log(body.slice(0, 500));
