import { Fragment } from "react";

export type TreeViewProps<TData> = {
  tree: FlatTree<TData>;
  renderNode: (params: {
    node: FlatTreeItem<TData>;
    state: { state: NodeState; visibility: NodeVisibility };
  }) => React.ReactNode;
  nodeStates?: NodeStates;
};

export function TreeView<TData>({ tree, renderNode, nodeStates }: TreeViewProps<TData>) {
  const state = useTreeState({
    tree,
    nodeStates,
  });

  //todo change renderer to use TanStack virtualizer
  console.log("state", state);

  return (
    <div>
      {tree.map((node) => (
        <Fragment key={node.id}>
          {renderNode({
            node,
            state: state.nodes[node.id],
          })}
        </Fragment>
      ))}
    </div>
  );
}

type NodeState = {
  selected: boolean;
  expanded: boolean;
};

type NodeVisibility = "visible" | "hidden";
type NodeStates = Record<string, NodeState>;

type TreeStateHookProps = {
  tree: FlatTree<any>;
  nodeStates?: NodeStates;
  onNodeStateChange?: (
    nodeId: string,
    state: { state: NodeState; visibility: NodeVisibility }
  ) => void;
  selectNode?: (id: string) => void;
  selectNextVisibleNode?: () => void;
  selectPreviousVisibleNode?: () => void;
  expandNode?: (id: string) => void;
  collapseNode?: (id: string) => void;
};

type TreeState = {
  selected: string | undefined;
  nodes: Record<
    string,
    {
      state: NodeState;
      visibility: NodeVisibility;
    }
  >;
};

export function useTreeState({ tree, nodeStates }: TreeStateHookProps): TreeState {
  if (!nodeStates) {
    nodeStates = {} as NodeStates;
  }

  const stateEntries = Object.entries<NodeState>(nodeStates);
  const selected = stateEntries.find(([id, state]) => state.selected)?.[0];

  //create the state and visibility for each Node
  //Nodes where the parent is collapsed are hidden, and can't be selected
  const nodes = tree.reduce((acc, node) => {
    //groups are open by default
    const state = nodeStates![node.id] ?? {
      selected: false,
      expanded: node.hasChildren ? true : false,
    };
    const parent = node.parentId
      ? acc[node.parentId]
      : { state: { selected: false, expanded: true }, visibility: "visible" };
    const visibility =
      parent.state.expanded && parent.visibility === "visible" ? "visible" : "hidden";
    acc[node.id] = { state, visibility };
    return acc;
  }, {} as Record<string, { state: NodeState; visibility: NodeVisibility }>);

  return {
    selected,
    nodes,
  };
}

/** An actual tree structure with custom data */
export type Tree<TData> = {
  id: string;
  children?: Tree<TData>[];
  data: TData;
};

/** A tree but flattened so it can easily be used for DOM elements */
export type FlatTreeItem<TData> = {
  id: string;
  parentId: string | undefined;
  children: string[];
  hasChildren: boolean;
  /** The indentation level, the root is 0 */
  level: number;
  data: TData;
};

export type FlatTree<TData> = FlatTreeItem<TData>[];

export function flattenTree<TData>(tree: Tree<TData>): FlatTree<TData> {
  const flatTree: FlatTree<TData> = [];

  function flattenNode(node: Tree<TData>, parentId: string | undefined, level: number) {
    const children = node.children?.map((child) => child.id) ?? [];
    flatTree.push({
      id: node.id,
      parentId,
      children,
      hasChildren: children.length > 0,
      level,
      data: node.data,
    });

    node.children?.forEach((child) => {
      flattenNode(child, node.id, level + 1);
    });
  }

  flattenNode(tree, undefined, 0);

  return flatTree;
}