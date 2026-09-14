import { render } from "preact";

export function App() {
  return <h1>bddb</h1>;
}

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
