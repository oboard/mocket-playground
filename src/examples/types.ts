export type ExampleId = "hello" | "params" | "api" | "echo";

export type Example = {
  name: ExampleId;
  label: string;
  subtitle: string;
  code: string;
};
