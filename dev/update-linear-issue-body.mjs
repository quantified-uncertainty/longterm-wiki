#!/usr/bin/env node
import fs from "node:fs";
import "dotenv/config";

const [, , issueIdentifier, bodyFile] = process.argv;
if (!issueIdentifier || !bodyFile) {
  console.error("Usage: update-linear-issue-body.mjs <QUA-NNN> <body-file>");
  process.exit(1);
}
const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error("LINEAR_API_KEY missing");
  process.exit(1);
}
const description = fs.readFileSync(bodyFile, "utf8");

const lookupQuery = `query($id: String!) { issue(id: $id) { id identifier title } }`;
const lookupRes = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: apiKey },
  body: JSON.stringify({ query: lookupQuery, variables: { id: issueIdentifier } }),
});
const lookup = await lookupRes.json();
const internalId = lookup?.data?.issue?.id;
if (!internalId) {
  console.error("Issue lookup failed:", JSON.stringify(lookup));
  process.exit(1);
}

const mutation = `
  mutation($id: String!, $description: String!) {
    issueUpdate(id: $id, input: { description: $description }) {
      success
      issue { identifier title }
    }
  }
`;
const res = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: apiKey },
  body: JSON.stringify({ query: mutation, variables: { id: internalId, description } }),
});
const json = await res.json();
if (!json?.data?.issueUpdate?.success) {
  console.error("Update failed:", JSON.stringify(json));
  process.exit(1);
}
console.log("Updated", json.data.issueUpdate.issue.identifier);
