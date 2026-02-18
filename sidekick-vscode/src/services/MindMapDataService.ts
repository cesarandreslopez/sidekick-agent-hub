/**
 * @fileoverview Service for transforming session data into mind map graph structure.
 *
 * This module provides a static service that transforms Claude Code session statistics
 * into a graph structure suitable for D3.js force-directed visualization.
 *
 * @module services/MindMapDataService
 */

import { SessionStats, ToolCall, TimelineEvent, SubagentStats, TaskState, TrackedTask, PlanState } from '../types/claudeSession';
import { GraphNode, GraphLink, GraphData, TaskNodeStatus, PlanStepStatus } from '../types/mindMap';
import { calculateLineChanges } from '../utils/lineChangeCalculator';
import { log } from './Logger';

/**
 * Transforms Claude Code session data into graph structure for D3.js visualization.
 *
 * Static class (no instantiation needed) following ModelPricingService pattern.
 * Creates a hub-and-spoke graph with the session as the central node and
 * files, tools, TODOs, and subagents as peripheral nodes.
 */
export class MindMapDataService {
  /** TODO extraction pattern for timeline descriptions */
  private static readonly TODO_PATTERN = /TODO:?\s*(.+?)(?:\n|$)/gi;

  /** File path tools that operate on files */
  private static readonly FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit'];

  /** URL-based tools */
  private static readonly URL_TOOLS = ['WebFetch', 'WebSearch'];

  /** Search tools that operate on directories */
  private static readonly SEARCH_TOOLS = ['Grep', 'Glob'];

  /** Shell command tools */
  private static readonly SHELL_TOOLS = ['Bash'];

  /** Common command names to extract from bash commands */
  private static readonly COMMAND_PATTERNS = /^(git|npm|npx|yarn|pnpm|node|python|pip|docker|make|cargo|go|rustc|tsc|eslint|prettier|vitest|jest|pytest)/i;

  /** Task-related tools (not visualized as separate nodes) */
  private static readonly TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite', 'TodoRead', 'UpdatePlan'];

  /**
   * Builds complete graph from session statistics.
   *
   * Creates a hierarchical structure:
   * - Central "session-root" node
   * - Tool nodes connected to session
   * - File nodes connected to tools (not directly to session)
   * - TODO nodes connected to session
   * - Subagent nodes connected to session
   *   - Subagent tool nodes connected to subagent
   *   - Subagent file nodes connected to subagent tools
   *
   * @param stats - Session statistics from SessionMonitor
   * @param subagents - Optional subagent statistics for expanded visualization
   * @returns Graph data with nodes and links
   */
  static buildGraph(stats: SessionStats, subagents?: SubagentStats[]): GraphData {
    // Debug logging for subagent data
    if (subagents && subagents.length > 0) {
      log(`[MindMap] Building graph with ${subagents.length} subagents:`);
      for (const agent of subagents) {
        log(`  - Agent ${agent.agentId}: type=${agent.agentType}, toolCalls=${agent.toolCalls.length}`);
        if (agent.toolCalls.length > 0) {
          const toolNames = [...new Set(agent.toolCalls.map(c => c.name))];
          log(`    Tools: ${toolNames.join(', ')}`);
        }
      }
    } else {
      log('[MindMap] Building graph with NO subagents');
    }
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const nodeIds = new Set<string>();

    // Add session center node
    const sessionNode: GraphNode = {
      id: 'session-root',
      label: 'Session',
      type: 'session',
      count: stats.messageCount,
    };
    nodes.push(sessionNode);
    nodeIds.add(sessionNode.id);

    // Add file nodes (linked to tools, not directly to session)
    const files = this.extractFiles(stats.toolCalls);
    files.forEach((stats, filePath) => {
      const id = `file-${filePath}`;
      if (!nodeIds.has(id)) {
        nodes.push({
          id,
          label: this.getFileName(filePath),
          fullPath: filePath,
          type: 'file',
          count: stats.touchCount,
          additions: stats.additions,
          deletions: stats.deletions,
        });
        nodeIds.add(id);
        // Note: files are linked to tools via addFileToolLinks, not to session directly
      }
    });

    // Add URL nodes (linked to WebFetch/WebSearch tools)
    const urls = this.extractUrls(stats.toolCalls);
    urls.forEach((count, url) => {
      const id = `url-${url}`;
      if (!nodeIds.has(id)) {
        nodes.push({
          id,
          label: this.getUrlLabel(url),
          fullPath: url,
          type: 'url',
          count,
        });
        nodeIds.add(id);
      }
    });

    // Add directory nodes (linked to Grep/Glob tools)
    const directories = this.extractDirectories(stats.toolCalls);
    directories.forEach((dirStats, dirPath) => {
      const id = `directory-${dirPath}`;
      if (!nodeIds.has(id)) {
        // Build tooltip showing path and patterns searched
        let tooltip = dirPath;
        if (dirStats.patterns.length > 0) {
          tooltip += '\n\nPatterns:\n• ' + dirStats.patterns.slice(0, 5).join('\n• ');
          if (dirStats.patterns.length > 5) {
            tooltip += `\n• ... and ${dirStats.patterns.length - 5} more`;
          }
        }
        nodes.push({
          id,
          label: this.getDirLabel(dirPath),
          fullPath: tooltip,
          type: 'directory',
          count: dirStats.count,
        });
        nodeIds.add(id);
      }
    });

    // Add command nodes (linked to Bash tool)
    const commands = this.extractCommands(stats.toolCalls);
    commands.forEach((cmdStats, cmdName) => {
      const id = `command-${cmdName}`;
      if (!nodeIds.has(id)) {
        // Build tooltip showing command examples
        let tooltip = cmdName;
        if (cmdStats.examples.length > 0) {
          tooltip += '\n\nCommands:\n• ' + cmdStats.examples.join('\n• ');
        }
        nodes.push({
          id,
          label: cmdName,
          fullPath: tooltip,
          type: 'command',
          count: cmdStats.count,
        });
        nodeIds.add(id);
      }
    });

    // Add tool nodes with call counts
    stats.toolAnalytics.forEach((analytics, toolName) => {
      const id = `tool-${toolName}`;
      if (!nodeIds.has(id)) {
        nodes.push({
          id,
          label: toolName,
          type: 'tool',
          count: analytics.completedCount,
        });
        nodeIds.add(id);
        links.push({ source: 'session-root', target: id });
      }
    });

    // Add TODO nodes
    const todos = this.extractTODOs(stats.timeline);
    todos.forEach((todo, index) => {
      const id = `todo-${index}`;
      nodes.push({
        id,
        label: this.truncateLabel(todo, 30),
        fullPath: todo,
        type: 'todo',
      });
      nodeIds.add(id);
      links.push({ source: 'session-root', target: id });
    });

    // Add task nodes from taskState
    if (stats.taskState) {
      this.addTaskNodes(stats.taskState, nodes, links, nodeIds);
    }

    // Add plan nodes from planState
    if (stats.planState && stats.planState.steps.length > 0) {
      this.addPlanNodes(stats.planState, nodes, links, nodeIds, stats.taskState);
    }

    // Add subagent nodes with hierarchical structure
    if (subagents && subagents.length > 0) {
      const nodesBefore = nodes.length;
      const linksBefore = links.length;
      this.addSubagentNodes(subagents, nodes, links, nodeIds);
      log(`[MindMap] addSubagentNodes added ${nodes.length - nodesBefore} nodes and ${links.length - linksBefore} links`);
    } else {
      // Fallback: extract subagents from timeline (legacy behavior)
      const legacySubagents = this.extractSubagents(stats.timeline);
      legacySubagents.forEach((count, agentId) => {
        const id = `subagent-${agentId}`;
        if (!nodeIds.has(id)) {
          nodes.push({
            id,
            label: `Subagent ${agentId}`,
            type: 'subagent',
            count,
          });
          nodeIds.add(id);
          links.push({ source: 'session-root', target: id });
        }
      });
    }

    // Create file-to-tool links
    this.addFileToolLinks(stats.toolCalls, nodeIds, links);

    // Create URL-to-tool links
    this.addUrlToolLinks(stats.toolCalls, nodeIds, links);

    // Create directory-to-tool links
    this.addDirectoryToolLinks(stats.toolCalls, nodeIds, links);

    // Create command-to-tool links
    this.addCommandToolLinks(stats.toolCalls, nodeIds, links);

    // Mark the latest file/URL link based on last tool call
    const lastFileUrlCall = [...stats.toolCalls]
      .reverse()
      .find(c => this.FILE_TOOLS.includes(c.name) || this.URL_TOOLS.includes(c.name));

    if (lastFileUrlCall) {
      const toolId = `tool-${lastFileUrlCall.name}`;
      let targetId: string | undefined;

      if (this.FILE_TOOLS.includes(lastFileUrlCall.name)) {
        const path = lastFileUrlCall.input.file_path as string;
        if (path) targetId = `file-${path}`;
      } else {
        const url = (lastFileUrlCall.input.url || lastFileUrlCall.input.query) as string;
        if (url) targetId = `url-${url}`;
      }

      if (targetId) {
        const latestLink = links.find(l => l.source === toolId && l.target === targetId);
        if (latestLink) latestLink.isLatest = true;
      }
    }

    return { nodes, links };
  }

  /**
   * File statistics including touch count and line changes.
   */
  private static extractFiles(toolCalls: ToolCall[]): Map<string, { touchCount: number; additions: number; deletions: number }> {
    const files = new Map<string, { touchCount: number; additions: number; deletions: number }>();

    for (const call of toolCalls) {
      if (this.FILE_TOOLS.includes(call.name)) {
        const filePath = call.input.file_path as string;
        if (filePath && typeof filePath === 'string') {
          const existing = files.get(filePath) || { touchCount: 0, additions: 0, deletions: 0 };
          existing.touchCount += 1;

          // Calculate line changes for modifying tools (Write, Edit, MultiEdit)
          const changes = calculateLineChanges(call.name, call.input);
          existing.additions += changes.additions;
          existing.deletions += changes.deletions;

          files.set(filePath, existing);
        }
      }
    }

    return files;
  }

  /**
   * Extracts URLs from WebFetch/WebSearch tool calls with access counts.
   *
   * @param toolCalls - Array of tool calls from session
   * @returns Map of URLs to access counts
   */
  private static extractUrls(toolCalls: ToolCall[]): Map<string, number> {
    const urls = new Map<string, number>();

    for (const call of toolCalls) {
      if (this.URL_TOOLS.includes(call.name)) {
        // WebFetch uses 'url', WebSearch uses 'query'
        const url = (call.input.url as string) || (call.input.query as string);
        if (url && typeof url === 'string') {
          const count = urls.get(url) || 0;
          urls.set(url, count + 1);
        }
      }
    }

    return urls;
  }

  /**
   * Extracts directories from Grep/Glob tool calls with search details.
   *
   * @param toolCalls - Array of tool calls from session
   * @returns Map of directory paths to search stats (count and patterns used)
   */
  private static extractDirectories(toolCalls: ToolCall[]): Map<string, { count: number; patterns: string[] }> {
    const dirs = new Map<string, { count: number; patterns: string[] }>();

    for (const call of toolCalls) {
      if (this.SEARCH_TOOLS.includes(call.name)) {
        const path = call.input.path as string;
        if (path && typeof path === 'string') {
          const existing = dirs.get(path) || { count: 0, patterns: [] };
          existing.count += 1;

          // Capture the search pattern (Grep uses 'pattern', Glob uses 'pattern')
          const pattern = call.input.pattern as string;
          if (pattern && !existing.patterns.includes(pattern)) {
            existing.patterns.push(pattern);
          }

          dirs.set(path, existing);
        }
      }
    }

    return dirs;
  }

  /**
   * Extracts command names from Bash tool calls with execution details.
   *
   * @param toolCalls - Array of tool calls from session
   * @returns Map of command names to execution stats (count and example commands)
   */
  private static extractCommands(toolCalls: ToolCall[]): Map<string, { count: number; examples: string[] }> {
    const commands = new Map<string, { count: number; examples: string[] }>();

    for (const call of toolCalls) {
      if (this.SHELL_TOOLS.includes(call.name)) {
        const cmd = call.input.command as string;
        if (cmd && typeof cmd === 'string') {
          const match = cmd.match(this.COMMAND_PATTERNS);
          if (match) {
            const cmdName = match[1].toLowerCase();
            const existing = commands.get(cmdName) || { count: 0, examples: [] };
            existing.count += 1;

            // Capture unique command examples (truncated for display)
            const shortCmd = this.truncateLabel(cmd.split('\n')[0], 60);
            if (!existing.examples.includes(shortCmd) && existing.examples.length < 5) {
              existing.examples.push(shortCmd);
            }

            commands.set(cmdName, existing);
          }
        }
      }
    }

    return commands;
  }

  /**
   * Extracts display label from directory path.
   *
   * @param dirPath - Full directory path
   * @returns Last directory component or '.' for current dir
   */
  private static getDirLabel(dirPath: string): string {
    if (!dirPath || dirPath === '.') return '.';
    const parts = dirPath.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || dirPath;
  }

  /**
   * Extracts TODOs from timeline event descriptions.
   *
   * @param timeline - Array of timeline events
   * @returns Array of unique TODO strings
   */
  private static extractTODOs(timeline: TimelineEvent[]): string[] {
    const todos: string[] = [];
    const seen = new Set<string>();

    for (const event of timeline) {
      const matches = event.description.matchAll(this.TODO_PATTERN);
      for (const match of matches) {
        const todo = match[1].trim();
        if (todo && !seen.has(todo.toLowerCase())) {
          todos.push(todo);
          seen.add(todo.toLowerCase());
        }
      }
    }

    return todos;
  }

  /**
   * Extracts subagent identifiers from timeline.
   *
   * Looks for events with 'subagent', 'sidechain', or 'spawned' in description.
   *
   * @param timeline - Array of timeline events
   * @returns Map of agent identifiers to event counts
   */
  private static extractSubagents(timeline: TimelineEvent[]): Map<string, number> {
    const subagents = new Map<string, number>();

    for (const event of timeline) {
      const desc = event.description.toLowerCase();
      if (desc.includes('subagent') || desc.includes('sidechain') || desc.includes('spawned')) {
        // Extract agent identifier if present, otherwise use generic
        const agentMatch = event.description.match(/(?:subagent|agent)\s*[-:]?\s*(\w+)/i);
        const agentId = agentMatch ? agentMatch[1] : 'worker';
        const count = subagents.get(agentId) || 0;
        subagents.set(agentId, count + 1);
      }
    }

    return subagents;
  }

  /**
   * Creates unique links between tool nodes and target nodes.
   *
   * Generic helper that iterates tool calls matching the given tool names,
   * extracts a target node ID via the provided function, and adds unique
   * tool-to-target links.
   *
   * @param toolCalls - Array of tool calls from session
   * @param toolNames - Tool names to match
   * @param getTargetId - Function to extract target node ID from a tool call (or null to skip)
   * @param existingNodeIds - Set of existing node IDs
   * @param links - Links array to add to
   */
  private static addToolTargetLinks(
    toolCalls: ToolCall[],
    toolNames: string[],
    getTargetId: (call: ToolCall) => string | null,
    existingNodeIds: Set<string>,
    links: GraphLink[]
  ): void {
    const addedLinks = new Set<string>();

    for (const call of toolCalls) {
      if (!toolNames.includes(call.name)) continue;

      const targetId = getTargetId(call);
      if (!targetId) continue;

      const toolId = `tool-${call.name}`;
      if (!existingNodeIds.has(targetId) || !existingNodeIds.has(toolId)) continue;

      const linkKey = `${toolId}-${targetId}`;
      if (!addedLinks.has(linkKey)) {
        links.push({ source: toolId, target: targetId });
        addedLinks.add(linkKey);
      }
    }
  }

  /**
   * Creates links between files and the tools that touched them.
   */
  private static addFileToolLinks(toolCalls: ToolCall[], existingNodeIds: Set<string>, links: GraphLink[]): void {
    this.addToolTargetLinks(toolCalls, this.FILE_TOOLS, call => {
      const filePath = call.input.file_path as string;
      return filePath && typeof filePath === 'string' ? `file-${filePath}` : null;
    }, existingNodeIds, links);
  }

  /**
   * Creates links between URLs/queries and the tools that accessed them.
   */
  private static addUrlToolLinks(toolCalls: ToolCall[], existingNodeIds: Set<string>, links: GraphLink[]): void {
    this.addToolTargetLinks(toolCalls, this.URL_TOOLS, call => {
      const url = (call.input.url as string) || (call.input.query as string);
      return url && typeof url === 'string' ? `url-${url}` : null;
    }, existingNodeIds, links);
  }

  /**
   * Creates links between directories and the tools that searched them.
   */
  private static addDirectoryToolLinks(toolCalls: ToolCall[], existingNodeIds: Set<string>, links: GraphLink[]): void {
    this.addToolTargetLinks(toolCalls, this.SEARCH_TOOLS, call => {
      const dirPath = call.input.path as string;
      return dirPath && typeof dirPath === 'string' ? `directory-${dirPath}` : null;
    }, existingNodeIds, links);
  }

  /**
   * Creates links between command types and the Bash tool that ran them.
   */
  private static addCommandToolLinks(toolCalls: ToolCall[], existingNodeIds: Set<string>, links: GraphLink[]): void {
    this.addToolTargetLinks(toolCalls, this.SHELL_TOOLS, call => {
      const cmd = call.input.command as string;
      if (!cmd || typeof cmd !== 'string') return null;
      const match = cmd.match(this.COMMAND_PATTERNS);
      return match ? `command-${match[1].toLowerCase()}` : null;
    }, existingNodeIds, links);
  }

  /**
   * Adds task nodes from TaskState to the graph.
   *
   * Creates task nodes and links them to:
   * - Session root
   * - Tools and files used while task was in_progress (task-action links)
   * - Other tasks via blockedBy relationships (task-dependency links)
   *
   * @param taskState - Task state containing tasks map
   * @param nodes - Nodes array to add to
   * @param links - Links array to add to
   * @param nodeIds - Set of existing node IDs
   */
  private static addTaskNodes(
    taskState: TaskState,
    nodes: GraphNode[],
    links: GraphLink[],
    nodeIds: Set<string>
  ): void {
    // Filter out deleted tasks
    const visibleTasks = Array.from(taskState.tasks.values())
      .filter(task => task.status !== 'deleted');

    for (const task of visibleTasks) {
      const taskNodeId = `task-${task.taskId}`;

      if (!nodeIds.has(taskNodeId)) {
        // Map task status to node status
        let taskStatus: TaskNodeStatus = 'pending';
        if (task.status === 'in_progress') taskStatus = 'in_progress';
        else if (task.status === 'completed') taskStatus = 'completed';

        nodes.push({
          id: taskNodeId,
          label: this.truncateLabel(task.subject, 25),
          fullPath: task.description || task.subject,
          type: 'task',
          count: task.associatedToolCalls.length,
          taskStatus,
          taskId: task.taskId,
        });
        nodeIds.add(taskNodeId);

        // Link task to session root
        links.push({ source: 'session-root', target: taskNodeId });
      }

      // Add task-action links for associated tool calls
      this.addTaskActionLinks(task, taskNodeId, nodeIds, links);

      // Add task-dependency links for blockedBy relationships
      this.addTaskDependencyLinks(task, taskNodeId, nodeIds, links);
    }
  }

  /**
   * Adds task-action links connecting a task to tools/files used while in_progress.
   *
   * @param task - The tracked task
   * @param taskNodeId - Node ID of the task
   * @param nodeIds - Set of existing node IDs
   * @param links - Links array to add to
   */
  private static addTaskActionLinks(
    task: TrackedTask,
    taskNodeId: string,
    nodeIds: Set<string>,
    links: GraphLink[]
  ): void {
    const addedLinks = new Set<string>();

    for (const call of task.associatedToolCalls) {
      // Skip task tools themselves
      if (this.TASK_TOOLS.includes(call.name)) continue;

      // Link to tool node
      const toolNodeId = `tool-${call.name}`;
      if (nodeIds.has(toolNodeId)) {
        const linkKey = `${taskNodeId}-${toolNodeId}`;
        if (!addedLinks.has(linkKey)) {
          links.push({
            source: taskNodeId,
            target: toolNodeId,
            linkType: 'task-action',
          });
          addedLinks.add(linkKey);
        }
      }

      // Link to file node if this is a file operation
      if (this.FILE_TOOLS.includes(call.name)) {
        const filePath = call.input.file_path as string;
        if (filePath) {
          const fileNodeId = `file-${filePath}`;
          if (nodeIds.has(fileNodeId)) {
            const linkKey = `${taskNodeId}-${fileNodeId}`;
            if (!addedLinks.has(linkKey)) {
              links.push({
                source: taskNodeId,
                target: fileNodeId,
                linkType: 'task-action',
              });
              addedLinks.add(linkKey);
            }
          }
        }
      }
    }
  }

  /**
   * Adds task-dependency links for blockedBy relationships.
   *
   * @param task - The tracked task
   * @param taskNodeId - Node ID of the task
   * @param nodeIds - Set of existing node IDs
   * @param links - Links array to add to
   */
  private static addTaskDependencyLinks(
    task: TrackedTask,
    taskNodeId: string,
    nodeIds: Set<string>,
    links: GraphLink[]
  ): void {
    for (const blockingTaskId of task.blockedBy) {
      const blockingNodeId = `task-${blockingTaskId}`;
      if (nodeIds.has(blockingNodeId)) {
        // Link from blocking task to this task (direction: blocker → blocked)
        links.push({
          source: blockingNodeId,
          target: taskNodeId,
          linkType: 'task-dependency',
        });
      }
    }
  }

  /**
   * Adds plan nodes from PlanState to the graph.
   *
   * Creates:
   * - Plan root node linked from session-root
   * - Plan-step nodes linked from plan root
   * - Sequential links between consecutive steps
   * - Cross-reference links from plan steps to matching task nodes
   *
   * @param planState - Plan state containing steps
   * @param nodes - Nodes array to add to
   * @param links - Links array to add to
   * @param nodeIds - Set of existing node IDs
   * @param taskState - Optional task state for cross-referencing
   */
  private static addPlanNodes(
    planState: PlanState,
    nodes: GraphNode[],
    links: GraphLink[],
    nodeIds: Set<string>,
    taskState?: TaskState
  ): void {
    // Create plan root node
    const planRootId = 'plan-root';
    if (!nodeIds.has(planRootId)) {
      nodes.push({
        id: planRootId,
        label: planState.title || 'Plan',
        fullPath: `${planState.title || 'Plan'} (${planState.steps.length} steps)`,
        type: 'plan',
        count: planState.steps.length,
      });
      nodeIds.add(planRootId);
      links.push({ source: 'session-root', target: planRootId });
    }

    // Create plan-step nodes
    for (let i = 0; i < planState.steps.length; i++) {
      const step = planState.steps[i];
      const stepNodeId = `plan-step-${i}`;

      if (!nodeIds.has(stepNodeId)) {
        const stepStatus: PlanStepStatus = step.status;
        const phaseLabel = step.phase ? `[${step.phase}] ` : '';
        nodes.push({
          id: stepNodeId,
          label: this.truncateLabel(`${phaseLabel}${step.description}`, 30),
          fullPath: step.description,
          type: 'plan-step',
          planStepStatus: stepStatus,
        });
        nodeIds.add(stepNodeId);

        // Link step to plan root
        links.push({ source: planRootId, target: stepNodeId });

        // Sequential link to previous step
        if (i > 0) {
          links.push({
            source: `plan-step-${i - 1}`,
            target: stepNodeId,
            linkType: 'plan-sequence',
          });
        }
      }
    }

    // Cross-reference: link plan steps to matching task nodes
    if (taskState) {
      const tasks = Array.from(taskState.tasks.values()).filter(t => t.status !== 'deleted');

      for (let i = 0; i < planState.steps.length; i++) {
        const step = planState.steps[i];
        const stepNodeId = `plan-step-${i}`;
        if (!nodeIds.has(stepNodeId)) continue;

        // For Codex: direct index mapping (plan-{i} task IDs correspond to step-{i})
        if (planState.source === 'codex') {
          const codexTaskId = `plan-${i}`;
          const taskNodeId = `task-${codexTaskId}`;
          if (nodeIds.has(taskNodeId)) {
            links.push({
              source: stepNodeId,
              target: taskNodeId,
              linkType: 'task-action',
            });
            continue;
          }
        }

        // Fuzzy match: case-insensitive substring of step description against task subjects
        const stepLower = step.description.toLowerCase();
        for (const task of tasks) {
          const taskNodeId = `task-${task.taskId}`;
          if (!nodeIds.has(taskNodeId)) continue;
          const subjectLower = task.subject.toLowerCase();
          if (stepLower.includes(subjectLower) || subjectLower.includes(stepLower)) {
            links.push({
              source: stepNodeId,
              target: taskNodeId,
              linkType: 'task-action',
            });
            break; // One match per step
          }
        }
      }
    }
  }

  /**
   * Adds subagent nodes with hierarchical tool and file structure.
   *
   * Creates a tree structure for each subagent:
   * - Subagent node (connected to session-root)
   * - Tool nodes for each unique tool used by the subagent
   * - File/URL nodes connected to the subagent's tool nodes
   *
   * @param subagents - Array of subagent statistics
   * @param nodes - Nodes array to add to
   * @param links - Links array to add to
   * @param nodeIds - Set of existing node IDs
   */
  private static addSubagentNodes(
    subagents: SubagentStats[],
    nodes: GraphNode[],
    links: GraphLink[],
    nodeIds: Set<string>
  ): void {
    for (const agent of subagents) {
      // Create subagent node
      const agentNodeId = `subagent-${agent.agentId}`;

      // Build label from agent type and/or description
      let label = agent.agentType || 'Subagent';
      if (agent.description) {
        label = `${label}: ${this.truncateLabel(agent.description, 20)}`;
      }

      if (!nodeIds.has(agentNodeId)) {
        nodes.push({
          id: agentNodeId,
          label: this.truncateLabel(label, 30),
          fullPath: agent.description || `Agent ${agent.agentId}`,
          type: 'subagent',
          count: agent.toolCalls.length,
        });
        nodeIds.add(agentNodeId);
        links.push({ source: 'session-root', target: agentNodeId });
      }

      // Skip if no tool calls
      if (agent.toolCalls.length === 0) {
        continue;
      }

      // Aggregate tool calls by tool name
      const toolCounts = new Map<string, number>();
      for (const call of agent.toolCalls) {
        const count = toolCounts.get(call.name) || 0;
        toolCounts.set(call.name, count + 1);
      }

      // Create tool nodes for this subagent
      for (const [toolName, count] of toolCounts) {
        const toolNodeId = `subagent-${agent.agentId}-tool-${toolName}`;

        if (!nodeIds.has(toolNodeId)) {
          nodes.push({
            id: toolNodeId,
            label: toolName,
            type: 'tool',
            count,
          });
          nodeIds.add(toolNodeId);
          links.push({ source: agentNodeId, target: toolNodeId });
        }
      }

      // Extract files touched by this subagent and create nodes
      const subagentFiles = this.extractFiles(agent.toolCalls);
      for (const [filePath, fileStats] of subagentFiles) {
        const fileNodeId = `subagent-${agent.agentId}-file-${filePath}`;

        if (!nodeIds.has(fileNodeId)) {
          nodes.push({
            id: fileNodeId,
            label: this.getFileName(filePath),
            fullPath: filePath,
            type: 'file',
            count: fileStats.touchCount,
            additions: fileStats.additions,
            deletions: fileStats.deletions,
          });
          nodeIds.add(fileNodeId);
        }

        // Link file to the tools that touched it
        for (const call of agent.toolCalls) {
          if (this.FILE_TOOLS.includes(call.name)) {
            const callFilePath = call.input.file_path as string;
            if (callFilePath === filePath) {
              const toolNodeId = `subagent-${agent.agentId}-tool-${call.name}`;
              // Check if link already exists
              const linkExists = links.some(l => l.source === toolNodeId && l.target === fileNodeId);
              if (!linkExists && nodeIds.has(toolNodeId)) {
                links.push({ source: toolNodeId, target: fileNodeId });
              }
            }
          }
        }
      }

      // Extract URLs touched by this subagent
      const subagentUrls = this.extractUrls(agent.toolCalls);
      for (const [url, count] of subagentUrls) {
        const urlNodeId = `subagent-${agent.agentId}-url-${url}`;

        if (!nodeIds.has(urlNodeId)) {
          nodes.push({
            id: urlNodeId,
            label: this.getUrlLabel(url),
            fullPath: url,
            type: 'url',
            count,
          });
          nodeIds.add(urlNodeId);
        }

        // Link URL to the tools that accessed it
        for (const call of agent.toolCalls) {
          if (this.URL_TOOLS.includes(call.name)) {
            const callUrl = (call.input.url as string) || (call.input.query as string);
            if (callUrl === url) {
              const toolNodeId = `subagent-${agent.agentId}-tool-${call.name}`;
              // Check if link already exists
              const linkExists = links.some(l => l.source === toolNodeId && l.target === urlNodeId);
              if (!linkExists && nodeIds.has(toolNodeId)) {
                links.push({ source: toolNodeId, target: urlNodeId });
              }
            }
          }
        }
      }

      // Add subagent task nodes if present
      if (agent.taskState) {
        this.addSubagentTaskNodes(agent, agentNodeId, nodes, links, nodeIds);
      }
    }
  }

  /**
   * Adds task nodes for a subagent with scoped IDs.
   *
   * @param agent - Subagent statistics with taskState
   * @param agentNodeId - Parent subagent node ID
   * @param nodes - Nodes array to add to
   * @param links - Links array to add to
   * @param nodeIds - Set of existing node IDs
   */
  private static addSubagentTaskNodes(
    agent: SubagentStats,
    agentNodeId: string,
    nodes: GraphNode[],
    links: GraphLink[],
    nodeIds: Set<string>
  ): void {
    if (!agent.taskState) return;

    // Filter out deleted tasks
    const visibleTasks = Array.from(agent.taskState.tasks.values())
      .filter(task => task.status !== 'deleted');

    for (const task of visibleTasks) {
      const taskNodeId = `subagent-${agent.agentId}-task-${task.taskId}`;

      if (!nodeIds.has(taskNodeId)) {
        // Map task status to node status
        let taskStatus: TaskNodeStatus = 'pending';
        if (task.status === 'in_progress') taskStatus = 'in_progress';
        else if (task.status === 'completed') taskStatus = 'completed';

        nodes.push({
          id: taskNodeId,
          label: this.truncateLabel(task.subject, 25),
          fullPath: task.description || task.subject,
          type: 'task',
          count: task.associatedToolCalls.length,
          taskStatus,
          taskId: task.taskId,
        });
        nodeIds.add(taskNodeId);

        // Link task to subagent node
        links.push({ source: agentNodeId, target: taskNodeId });
      }

      // Add task-action links for associated tool calls (scoped to subagent)
      const addedLinks = new Set<string>();
      for (const call of task.associatedToolCalls) {
        if (this.TASK_TOOLS.includes(call.name)) continue;

        // Link to subagent's tool node
        const toolNodeId = `subagent-${agent.agentId}-tool-${call.name}`;
        if (nodeIds.has(toolNodeId)) {
          const linkKey = `${taskNodeId}-${toolNodeId}`;
          if (!addedLinks.has(linkKey)) {
            links.push({
              source: taskNodeId,
              target: toolNodeId,
              linkType: 'task-action',
            });
            addedLinks.add(linkKey);
          }
        }
      }

      // Add task-dependency links (scoped to subagent)
      for (const blockingTaskId of task.blockedBy) {
        const blockingNodeId = `subagent-${agent.agentId}-task-${blockingTaskId}`;
        if (nodeIds.has(blockingNodeId)) {
          links.push({
            source: blockingNodeId,
            target: taskNodeId,
            linkType: 'task-dependency',
          });
        }
      }
    }
  }

  /**
   * Extracts filename from full path.
   *
   * @param filePath - Full file path
   * @returns Just the filename
   */
  private static getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  /**
   * Extracts display label from URL or search query.
   *
   * For URLs, extracts the hostname. For search queries, truncates if needed.
   *
   * @param urlOrQuery - URL or search query string
   * @returns Shortened label for display
   */
  private static getUrlLabel(urlOrQuery: string): string {
    try {
      const url = new URL(urlOrQuery);
      return url.hostname;
    } catch {
      // Not a valid URL (probably a search query), truncate it
      return this.truncateLabel(urlOrQuery, 25);
    }
  }

  /**
   * Truncates label with ellipsis if too long.
   *
   * @param text - Text to truncate
   * @param maxLength - Maximum length before truncation
   * @returns Truncated text with ellipsis if needed
   */
  private static truncateLabel(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }
}
