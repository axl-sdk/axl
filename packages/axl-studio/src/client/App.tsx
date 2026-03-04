import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/layout/Sidebar';
import { PlaygroundPanel } from './panels/playground/PlaygroundPanel';
import { WorkflowRunnerPanel } from './panels/workflow-runner/WorkflowRunnerPanel';
import { TraceExplorerPanel } from './panels/trace-explorer/TraceExplorerPanel';
import { CostDashboardPanel } from './panels/cost-dashboard/CostDashboardPanel';
import { MemoryBrowserPanel } from './panels/memory-browser/MemoryBrowserPanel';
import { SessionManagerPanel } from './panels/session-manager/SessionManagerPanel';
import { ToolInspectorPanel } from './panels/tool-inspector/ToolInspectorPanel';
import { EvalRunnerPanel } from './panels/eval-runner/EvalRunnerPanel';

export function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/playground" element={<PlaygroundPanel />} />
            <Route path="/workflows" element={<WorkflowRunnerPanel />} />
            <Route path="/traces" element={<TraceExplorerPanel />} />
            <Route path="/costs" element={<CostDashboardPanel />} />
            <Route path="/memory" element={<MemoryBrowserPanel />} />
            <Route path="/sessions" element={<SessionManagerPanel />} />
            <Route path="/tools" element={<ToolInspectorPanel />} />
            <Route path="/evals" element={<EvalRunnerPanel />} />
            <Route path="*" element={<Navigate to="/playground" replace />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
