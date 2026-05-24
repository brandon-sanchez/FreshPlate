export type BarcodeProduct = {
  barcode: string;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  categories: string[];
  image_url: string | null;
};

export type BarcodeLookupResponse = {
  data: BarcodeProduct | null;
};
