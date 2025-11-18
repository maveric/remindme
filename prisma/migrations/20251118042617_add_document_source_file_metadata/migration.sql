-- AlterTable
ALTER TABLE "BusinessDocument" ADD COLUMN     "sourceFileBucket" TEXT,
ADD COLUMN     "sourceFileContentType" TEXT,
ADD COLUMN     "sourceFileName" TEXT,
ADD COLUMN     "sourceFilePath" TEXT,
ADD COLUMN     "sourceFileSize" INTEGER;
