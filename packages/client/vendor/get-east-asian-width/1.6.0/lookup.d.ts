export declare function getCategory(codePoint: number): "ambiguous" | "fullwidth" | "halfwidth" | "narrow" | "wide" | "neutral";
export declare function isAmbiguous(codePoint: number): boolean;
export declare function isFullWidth(codePoint: number): boolean;
export declare function isWide(codePoint: number): boolean;
