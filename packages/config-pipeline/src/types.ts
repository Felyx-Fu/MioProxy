export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface MihomoProxyGroup extends JsonObject {
  name: string;
  type: string;
  proxies?: string[];
  use?: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

export interface MihomoConfig extends JsonObject {
  proxies?: JsonObject[];
  "proxy-groups"?: MihomoProxyGroup[];
  rules?: string[];
}

export interface PipelineWarning {
  code: string;
  message: string;
  path: string;
}
