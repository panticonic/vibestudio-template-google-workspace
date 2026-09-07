import { useState, useCallback } from "react";
import { Button, Dialog, Flex } from "@radix-ui/themes";
import type { MethodAdvertisement } from "@workspace/pubsub";
import { JsonSchemaForm, validateSchemaForm } from "./JsonSchemaForm";

export interface MethodArgumentsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  method: MethodAdvertisement;
  providerName: string;
  onSubmit: (args: Record<string, unknown>) => void;
}

/**
 * Modal dialog for entering method arguments before invocation.
 */
export function MethodArgumentsModal({
  open,
  onOpenChange,
  method,
  providerName,
  onSubmit,
}: MethodArgumentsModalProps) {
  const [formValue, setFormValue] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = useCallback(() => {
    const validationErrors = validateSchemaForm(method.parameters, formValue);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    onSubmit(formValue);
    onOpenChange(false);
    // Reset form for next use
    setFormValue({});
  }, [formValue, method.parameters, onSubmit, onOpenChange]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        // Reset form when closing
        setFormValue({});
        setErrors({});
      }
      onOpenChange(isOpen);
    },
    [onOpenChange]
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content
        style={{
          width: "min(480px, calc(100vw - 24px))",
          maxHeight: "min(85dvh, 640px)",
          overflow: "auto",
        }}
      >
        <Dialog.Title>{method.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          {method.description ?? `Call method on ${providerName}`}
        </Dialog.Description>

        <JsonSchemaForm
          schema={method.parameters}
          value={formValue}
          onChange={setFormValue}
          errors={errors}
        />

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </Dialog.Close>
          <Button onClick={handleSubmit}>Call Method</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
