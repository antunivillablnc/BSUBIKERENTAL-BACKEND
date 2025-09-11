declare module 'formidable' {
  import { IncomingMessage } from 'http';

  export interface Fields {
    [key: string]: undefined | string | string[];
  }

  export interface File {
    filepath: string;
    originalFilename?: string | null;
    mimetype?: string | null;
    size?: number;
  }

  export interface Files {
    [key: string]: File | File[] | undefined;
  }

  export interface Options {
    keepExtensions?: boolean;
    multiples?: boolean;
    uploadDir?: string;
  }

  export interface Formidable {
    parse(
      req: IncomingMessage,
      callback: (err: any, fields: Fields, files: Files) => void
    ): void;
  }

  export default function formidable(options?: Options): Formidable;
}


