/** ZIP record signatures and field sentinels (APPNOTE.TXT 6.3.x). */
export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;
export const SIG_DATA_DESCRIPTOR = 0x08074b50;

export const EOCD_MIN_SIZE = 22;
export const ZIP64_LOCATOR_SIZE = 20;
export const ZIP64_EOCD_MIN_SIZE = 56;
export const CENTRAL_HEADER_SIZE = 46;
export const LOCAL_HEADER_SIZE = 30;
export const MAX_COMMENT = 0xffff;

export const U16_MAX = 0xffff;
export const U32_MAX = 0xffffffff;

export const EXTRA_ZIP64 = 0x0001;

export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_DATA_DESCRIPTOR = 0x0008;
export const FLAG_STRONG_ENCRYPTION = 0x0040;
export const FLAG_UTF8 = 0x0800;
export const FLAG_MASKED_HEADERS = 0x2000;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/** Host system codes in the high byte of "version made by". */
export const HOST_UNIX = 3;

/** Unix file type bits in the high 16 bits of external attributes. */
export const S_IFMT = 0o170000;
export const S_IFLNK = 0o120000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
