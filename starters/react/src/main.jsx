import React from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const POD_STAGES = [
  "planner",
  "engineering-a",
  "engineering-b",
  "qa-tests",
  "checker-engineering-a",
  "checker-engineering-b",
  "checker-qa-tests",
  "integration",
  "qa",
  "testing",
  "trusted-verification",
  "pre-publication-scan",
  "draft-pr-publication",
];

function App() {
  return (
    <main>
      <h1>MONOLITH_DEMO_READY</h1>
      <p>The Engineering agent can replace this starter with the requested interface.</p>
      <section aria-label="Engineering pod stages">
        <h2>Pod Stages</h2>
        <ol aria-label="Engineering pod stage list">
          {POD_STAGES.map((stage) => (
            <li key={stage} aria-label={`Stage: ${stage}`}>
              {stage}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
