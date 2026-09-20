import type { Example } from "./types";

const code = `async fn main {
  let app = @mocket.App()

  app.get("/api/hello", _ => {
    "Hello, World!"
  })

  app.listen(":4000")
}
`;

export const example: Example = {
  name: "hello",
  label: "Hello world",
  subtitle: "/hello/:name",
  code,
};
