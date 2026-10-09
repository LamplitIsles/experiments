import { inputs, jsonValue, type Method } from "../src/chord-contract";
import type { HostService } from "./hosts";
export async function invoke(app: HostService, member: Method, input: unknown) {
  // Each case narrows its schema before invoking the existing domain methods.
  const parse = <K extends Method>(
    key: K,
  ): import("zod").infer<(typeof inputs)[K]> =>
    inputs[key].parse(input) as import("zod").infer<(typeof inputs)[K]>;
  switch (member) {
    case "projects":
      return await app.projects();
    case "models":
      parse(member);
      return await app.models();
    case "weekly":
      parse(member);
      return await app.weekly();
    case "history": {
      const p = parse(member);
      return await app.history(p.project, p.query, p.cursor);
    }
    case "historySession": {
      const p = parse(member);
      return await app.historySession(p.project, p.threadId);
    }
    case "historyMessages": {
      const p = parse(member);
      return await app.historyMessages(p.project, p.threadId, p.cursor);
    }
    case "resumeHistory": {
      const p = parse(member);
      return await app.resumeHistory(
        p.project,
        p.threadId,
        p.archived,
        p.settings,
      );
    }
    case "agentHistory": {
      const p = parse(member);
      return await app.agentHistory(p.id, p.cursor);
    }
    case "detail":
      return await app.detail(parse(member).id);
    case "skills":
      return await app.skills(parse(member).id);
    case "createOrc": {
      const p = parse(member);
      return await app.createOrc(p.project, p.settings);
    }
    case "send": {
      const p = parse(member);
      return await app.send(p.id, p.text, p.operationId, p.images);
    }
    case "retryDelivery": {
      const p = parse(member);
      return await app.retryDelivery(p.id, p.deliveryId);
    }
    case "lookup": {
      const p = parse(member);
      return await app.lookup(p.id, p.operationId);
    }
    case "deleteFailedSubmission": {
      const p = parse(member);
      return await app.deleteFailedSubmission(p.id, p.operationId);
    }
    case "answerBatch": {
      const p = parse(member);
      return await app.answerBatch(p.id, p.answers, p.operationId);
    }
    case "stop": {
      const p = parse(member);
      return await app.stop(p.id, p.turnId);
    }
    case "updateSettings": {
      const p = parse(member);
      return await app.updateSettings(p.id, {
        model: p.model,
        effort: p.effort,
      });
    }
    case "updateTreeFast": {
      const p = parse(member);
      return await app.updateTreeFast(p.id, p.fast, p.retry);
    }
    case "rename": {
      const p = parse(member);
      return await app.rename(p.id, p.title);
    }
    case "closeTree":
      return await app.closeTree(parse(member).id);
    default:
      throw new Error("Invalid method");
  }
}
export { jsonValue };
