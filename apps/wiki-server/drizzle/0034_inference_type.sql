ALTER TABLE "claims" ADD COLUMN "inference_type" text;
CREATE INDEX "idx_cl_inference_type" ON "claims" ("inference_type");
