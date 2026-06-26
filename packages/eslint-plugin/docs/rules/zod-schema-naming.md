# zod-schema-naming

In `@nightcore/contracts`, every exported zod schema is a PascalCase const suffixed `Schema`, paired with a same-named inferred type.

## Rationale

The contracts package is the single shared spine. A uniform `FooSchema` + `Foo` pairing keeps the schema and its TypeScript type discoverable and prevents a hand-authored duplicate type from drifting away from the schema it is supposed to mirror.

## Incorrect

```ts
export const Task = z.object({});              // not suffixed `Schema`

export const TaskSchema = z.object({});         // no sibling inferred type
```

## Correct

```ts
export const TaskSchema = z.object({ id: z.string() });
export type Task = z.infer<typeof TaskSchema>;
```
