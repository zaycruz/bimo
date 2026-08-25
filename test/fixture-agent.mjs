const prompt = process.argv.at(-1) ?? "";

if (prompt.includes("[role=engineering]")) {
  console.log("Engineering completed the requested change.");
  console.log("MONOLITH_RESULT=completed");
} else if (prompt.includes("[role=qa]") && !prompt.includes("qa: failed")) {
  console.log("QA requested one correction.");
  console.log("MONOLITH_RESULT=failed");
} else {
  console.log("The gate passed.");
  console.log("MONOLITH_RESULT=passed");
}
