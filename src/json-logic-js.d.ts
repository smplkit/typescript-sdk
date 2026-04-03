declare module "json-logic-js" {
  const jsonLogic: {
    apply: (logic: Record<string, unknown>, data: Record<string, unknown>) => unknown;
  };
  export default jsonLogic;
}
