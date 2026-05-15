export const queryKeys = {
  health:         (baseUrl: string) => ['health', baseUrl] as const,
  collections:    (baseUrl: string) => ['collections', baseUrl] as const,
  introspection:  (baseUrl: string) => ['introspection', baseUrl] as const,
  documents:      (baseUrl: string, collection: string, page: number, search?: string) => ['documents', baseUrl, collection, page, search ?? ''] as const,
  documentsBase:  (baseUrl: string, collection: string) => ['documents', baseUrl, collection] as const,
  documentCount:      (baseUrl: string, collection: string, search?: string) => ['documentCount', baseUrl, collection, search ?? ''] as const,
  allDocumentCounts:  (baseUrl: string, collections: string[]) => ['allDocumentCounts', baseUrl, ...collections] as const,
  peers:          (baseUrl: string) => ['peers', baseUrl] as const,
}
