import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ConfirmRequest {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly run: () => Promise<void>
}

/** Destructive-action confirmation using DSH's warning modal. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  if (!request) return null
  return (
    <Modal
      open
      tone="warning"
      title={request.title}
      description={request.description}
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose()
              void request.run()
            }}
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    />
  )
}
