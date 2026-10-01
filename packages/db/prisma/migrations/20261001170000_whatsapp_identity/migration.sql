-- WhatsApp/Meta identity for Coexistence + BSUID rollout.
ALTER TABLE "contact"
  ADD COLUMN "whatsappUserId" TEXT,
  ADD COLUMN "whatsappParentUserId" TEXT,
  ADD COLUMN "whatsappUsername" TEXT;

CREATE UNIQUE INDEX "contact_whatsappUserId_key"
  ON "contact"("whatsappUserId");

CREATE INDEX "contact_whatsappParentUserId_idx"
  ON "contact"("whatsappParentUserId");

CREATE INDEX "contact_whatsappUsername_idx"
  ON "contact"("whatsappUsername");
