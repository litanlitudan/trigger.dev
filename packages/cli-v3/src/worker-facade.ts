import { flushOtel, getLogger, getTracer } from "./dev/tracer.js";

const otelTracer = getTracer("trigger-dev-worker", packageJson.version);
const otelLogger = getLogger("trigger-dev-worker", packageJson.version);

import { SpanKind } from "@opentelemetry/api";
import {
  DevRuntimeManager,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  TriggerTracer,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  parseError,
  runtime,
  taskContextManager,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import * as packageJson from "../package.json";

import { TaskMetadataWithRun } from "./types.js";
import { ConsoleLogger } from "./dev/consoleLogger";

const tracer = new TriggerTracer(otelTracer);
const consoleLogger = new ConsoleLogger(otelLogger);

const devRuntimeManager = new DevRuntimeManager({
  tracer,
});

runtime.setGlobalRuntimeManager(devRuntimeManager);

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

class TaskExecutor {
  constructor(public task: TaskMetadataWithRun) {}

  async execute(execution: TaskRunExecution, traceContext: Record<string, unknown>) {
    const parsedPayload = JSON.parse(execution.run.payload);
    const ctx = TaskRunContext.parse(execution);

    const output = await taskContextManager.runWith(
      {
        ctx,
        payload: parsedPayload,
      },
      async () => {
        return await tracer.startActiveSpan(
          `${execution.task.id} execute`,
          async (span) => {
            return await consoleLogger.intercept(console, async () => {
              return await this.task.run({
                payload: parsedPayload,
                ctx: TaskRunContext.parse(execution),
              });
            });
          },
          {
            kind: SpanKind.CONSUMER,
          },
          tracer.extractContext(traceContext)
        );
      }
    );

    return { output: JSON.stringify(output), outputType: "application/json" };
  }
}

function getTasks(): Array<TaskMetadataWithRun> {
  const result: Array<TaskMetadataWithRun> = [];

  for (const [importName, taskFile] of Object.entries(TaskFiles)) {
    const fileImports = TaskFileImports[importName];

    for (const [exportName, task] of Object.entries(fileImports ?? {})) {
      if ((task as any).__trigger) {
        result.push({
          id: (task as any).__trigger.id,
          exportName,
          packageVersion: (task as any).__trigger.packageVersion,
          filePath: (taskFile as any).filePath,
          run: (task as any).__trigger.run,
        });
      }
    }
  }

  return result;
}

function getTaskMetadata(): Array<TaskMetadataWithFilePath> {
  const result = getTasks();

  // Remove the run function from the metadata
  return result.map((task) => {
    const { run, ...metadata } = task;

    return metadata;
  });
}

const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

const tasks = getTasks();

const taskExecutors: Map<string, TaskExecutor> = new Map();

for (const task of tasks) {
  taskExecutors.set(task.id, new TaskExecutor(task));
}

const handler = new ZodMessageHandler({
  schema: workerToChildMessages,
  messages: {
    EXECUTE_TASK_RUN: async ({ execution, traceContext, metadata }) => {
      process.title = `trigger-dev-worker: ${execution.task.id} ${execution.attempt.id}`;

      const executor = taskExecutors.get(execution.task.id);

      if (!executor) {
        console.error(`Could not find executor for task ${execution.task.id}`);

        await sender.send("TASK_RUN_COMPLETED", {
          result: {
            ok: false,
            id: execution.attempt.id,
            error: {
              type: "INTERNAL_ERROR",
              code: TaskRunErrorCodes.COULD_NOT_FIND_EXECUTOR,
            },
          },
        });

        return;
      }

      try {
        const result = await executor.execute(execution, traceContext);

        return sender.send("TASK_RUN_COMPLETED", {
          result: {
            id: execution.attempt.id,
            ok: true,
            ...result,
          },
        });
      } catch (e) {
        return sender.send("TASK_RUN_COMPLETED", {
          result: {
            id: execution.attempt.id,
            ok: false,
            error: parseError(e),
          },
        });
      }
    },
    TASK_RUN_COMPLETED: async ({ completion, execution }) => {
      devRuntimeManager.resumeTask(completion, execution);
    },
    CLEANUP: async ({ flush }) => {
      if (flush) {
        await flushOtel();
      }

      // Now we need to exit the process
      await sender.send("READY_TO_DISPOSE", undefined);
    },
  },
});

process.on("message", async (msg: any) => {
  await handler.handleMessage(msg);
});

sender.send("TASKS_READY", { tasks: getTaskMetadata() }).catch((err) => {
  console.error("Failed to send TASKS_READY message", err);
});

process.title = "trigger-dev-worker";
