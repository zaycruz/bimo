import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// No daemon, VM or image pull: the agent's shell runs in just-bash.
export default defineSandbox({
  backend: justbash(),
});
