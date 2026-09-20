import { example as hello } from "./hello";
import { example as params } from "./params";
import { example as api } from "./api";
import { example as echo } from "./echo";
import type { Example, ExampleId } from "./types";

export type { Example, ExampleId };

export const examples: Example[] = [hello, params, api, echo];

export function getExample(name: ExampleId): Example {
  const example = examples.find((entry) => entry.name === name);
  if (!example) throw new Error(`Unknown example: ${name}`);
  return example;
}
