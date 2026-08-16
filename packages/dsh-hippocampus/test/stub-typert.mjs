// 测试桩：@deepseek-ai/dsh-typert-protocol（DSH 宿主注入，独立运行时用桩替代）
export const Remote = (_name) => (value, context) => {
  context?.addInitializer?.(() => {});
  return value;
};
export class TypertRemoteService {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
  }
}
