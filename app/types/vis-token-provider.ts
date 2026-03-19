export type VisTokenProviderDraft = {
  id: string;
  name: string;
  command: string;
};

export type VisTokenProviderTestDraft = Pick<VisTokenProviderDraft, 'name' | 'command'>;

export type VisTokenProviderDefinition = VisTokenProviderDraft & {
  updatedAt: number;
};

export type VisTokenProviderSaveDefinition = VisTokenProviderDraft & {
  updatedAt?: number | string;
};

export type VisTokenProviderConfigResponse = {
  definitions: VisTokenProviderDefinition[];
};

export type VisTokenProviderParsedRow = {
  leftText: string;
  rightText: string;
};

export type VisTokenProviderResultStatus =
  | 'empty'
  | 'running'
  | 'ok'
  | 'error'
  | 'timed_out'
  | 'invalid_output'
  | 'config_error';

export type VisTokenProviderResultBlock = {
  id: string;
  name: string;
  status: VisTokenProviderResultStatus;
  message: string;
  rows: readonly VisTokenProviderParsedRow[];
};

export type VisTokenProviderTestResponse = {
  result: VisTokenProviderResultBlock;
};

export type VisTokenProviderPanelState = 'ready' | 'empty' | 'config_error';

export type VisTokenProviderPanelResponse = {
  state: VisTokenProviderPanelState;
  message: string;
  providers: readonly VisTokenProviderResultBlock[];
};
