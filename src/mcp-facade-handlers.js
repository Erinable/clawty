export function createFacadeToolHandlers(deps = {}) {
  const {
    callMonitorTool,
    callSearchCodeFacade,
    callGoToDefinitionFacade,
    callFindReferencesFacade,
    callCodeContextFacade,
    callReindexCodebaseFacade,
    callExplainCodeFacade,
    callTraceCallChainFacade,
    callImpactAnalysisFacade
  } = deps;

  return {
    monitor_system: (args, serverOptions) =>
      callMonitorTool("monitor_report", args, serverOptions),
    search_code: callSearchCodeFacade,
    go_to_definition: callGoToDefinitionFacade,
    find_references: callFindReferencesFacade,
    get_code_context: callCodeContextFacade,
    reindex_codebase: callReindexCodebaseFacade,
    explain_code: callExplainCodeFacade,
    trace_call_chain: callTraceCallChainFacade,
    impact_analysis: callImpactAnalysisFacade
  };
}
