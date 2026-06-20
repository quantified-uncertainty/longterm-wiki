// Markdown link regex (new)
const re = /!?\[[^\]]*\]\((?:[^()]+|\([^()]*\))*\)/g;
const samples = [
  "[foo](http://x.com)",
  "![img](http://x.com/a.png)",
  "[bar](/wiki/Foo_(bar))",
  "text [a](u1) and [b](u2) end",
  "no link here",
  "[empty]()",
];
console.log("=== markdown link ===");
for (const s of samples) console.log(JSON.stringify(s), "=>", JSON.stringify(s.match(re)));

// SQL tuple regex (new)
const tre = /\((?:'(?:[^'\\]|'')*'|[^')]+)*\)/g;
const sql = [
  "(1, 'Alice', 100)",
  "('O''Brien', 'donee', 50)",
  "(1, 'a (nested) thing', 2)",
  "(123, NULL, 'x')",
];
console.log("=== sql tuple ===");
for (const s of sql) console.log(JSON.stringify(s), "=>", JSON.stringify(s.match(tre)));

// ReDoS timing check on pathological input
console.log("=== timing ===");
const evil = "[x](" + "(".repeat(40) + "a".repeat(40);
const t0 = Date.now();
evil.match(re);
console.log("markdown evil ms:", Date.now() - t0);
const evil2 = "(" + "a".repeat(50000);
const t1 = Date.now();
evil2.match(tre);
console.log("sql evil ms:", Date.now() - t1);
