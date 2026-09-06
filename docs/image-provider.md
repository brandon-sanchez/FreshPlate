# Image provider adapter

`OpenAIImageProvider` makes one GPT Image 2 request and validates the returned
base64 PNG. The caller must complete an atomic image reservation before calling
the adapter. Provider failures do not refund the reservation, and this adapter
does not retry or calculate spend.
