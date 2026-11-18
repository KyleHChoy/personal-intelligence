import type { EmbeddingRequest, EmbeddingResponse, ModelRequest, ModelResponse } from "@intelligence/contracts";

export interface ModelClient {
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
