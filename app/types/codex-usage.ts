export type CodexUsageWindow = {
  label: '5h' | '7d' | '30d';
  remainingPercent: number | null;
  remainingText: string;
  alert: boolean;
};

export type CodexUsageResponse = {
  state: 'ok' | 'login_required' | 'unavailable';
  stale: boolean;
  staleMinutes: number;
  message: string;
  windows: {
    fiveHour: CodexUsageWindow;
    sevenDay: CodexUsageWindow;
    tools30Day: CodexUsageWindow;
  };
};
