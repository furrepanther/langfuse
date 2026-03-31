declare module "jsonpath-plus" {
  export function JSONPath(options: {
    path: string | Array<string | number>;
    json: unknown;
  }): unknown;
}
