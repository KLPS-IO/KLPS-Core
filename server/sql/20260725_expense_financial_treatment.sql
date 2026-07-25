BEGIN;

ALTER TABLE finance_os.expenses
  ADD COLUMN IF NOT EXISTS financial_treatment text NOT NULL DEFAULT 'To Classify';

ALTER TABLE finance_os.expenses
  DROP CONSTRAINT IF EXISTS expenses_financial_treatment_check;

ALTER TABLE finance_os.expenses
  ADD CONSTRAINT expenses_financial_treatment_check CHECK (
    financial_treatment IN (
      'Operating Expense',
      'R&D Materials',
      'R&D Services',
      'Professional Services',
      'Business Development',
      'Marketing',
      'Premises',
      'Capital Expenditure',
      'Cost of Goods Sold',
      'Tax and Statutory',
      'Other',
      'To Classify'
    )
  );

UPDATE finance_os.expenses
SET
  financial_treatment = CASE import_key
    WHEN 'actual-domain-ionos-2026' THEN 'Operating Expense'
    WHEN 'actual-ffr-cohort9-2026' THEN 'Business Development'
    WHEN 'current-chatgpt-plus-2026' THEN 'Operating Expense'
    WHEN 'shared-sovereign-studios-workspace-2026' THEN 'Premises'
    WHEN 'planned-blooming-books-accountancy-2026' THEN 'Professional Services'
    ELSE 'To Classify'
  END,
  change_reason = CASE
    WHEN import_key LIKE 'paypal-%'
      THEN 'Financial treatment remains To Classify until item-level receipt evidence is reviewed.'
    ELSE change_reason
  END
WHERE import_key IN (
  'actual-domain-ionos-2026',
  'actual-ffr-cohort9-2026',
  'current-chatgpt-plus-2026',
  'shared-sovereign-studios-workspace-2026',
  'planned-blooming-books-accountancy-2026',
  'planned-business-insurance-2026'
) OR import_key LIKE 'paypal-%';

COMMIT;
