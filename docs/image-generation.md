# Pictures in the chat (v1.6 生成图片)

A member can make a picture when the configured model can; when it cannot, she says so
(这个模型不会画图) instead of pretending.

## Whether the model can draw

`apps/server/src/image-generation.ts` finds out from the gateway, never from the model's name:

1. The gateway's record of the model (`GET /models/:id`, else its row in `GET /models`). Some
   gateways say what a model serves: `api_supported["images/generations"]` (Volcengine Ark),
   `output_modalities` with `image` (OpenRouter). A record that names the model's APIs or
   modalities settles it, for or against, without a try.
2. Otherwise a real try: `POST /images/generations` with the model and a plain prompt; and,
   when the model asked is the chat model itself, a chat turn with `modalities: ["text",
   "image"]` looking for a picture in the reply. A try costs one small picture at most.

The verdict is kept in memory and in the records table (`image-ability`, keyed by gateway and
model) for a day. When no try got any answer from the gateway (it was down), the verdict is
`transient` and kept only ten minutes. `GET /api/chat/images/ability` gives it (`?refresh=1`
checks again, for a gateway configured or fixed since).

Settings: without `IMAGE_MODEL` the chat model (`MODEL`, provider prefix dropped) is asked;
`IMAGE_MODEL` names another model, `IMAGE_BASE_URL` / `IMAGE_API_KEY` another gateway (else
`OPENAI_BASE_URL` / `OPENAI_API_KEY`). Only the OpenAI-compatible wire format is spoken.
`IMAGE_EXTRA`, a JSON object, goes into every images request as it is (the request's own
fields win): a gateway's own switches, such as `{"watermark": false}` on one that stamps its
pictures unless told not to.
`IMAGE_GENERATION=off` turns the whole thing off: no check of the gateway at start, no tool,
nothing in the prompt about drawing (the tests run so: their fake model server must see only
the chat).

## Drawing

`apps/server/src/picture-tool.ts`: the `generate_image` tool (prompt, size square / wide / tall,
an optional short name) stands in the chat's and a task's tools only while the verdict is yes;
the prompt says either how to use it or, when the model cannot draw, to say so plainly and
offer words instead (a description, a prompt for a drawing tool). `drawPicture` asks the
gateway, keeps the picture as a chat attachment (`AttachmentStore`, so the hosted build has it
too), copies it to `/workspace/成品/<name>` on the members' computer when there is one
(`ComputerService.deliverFile`), and answers the model with the attachment's id, name, media
type and path, and a note to just say what it drew (no links, no base64).

## The card

The web finds the pictures a reply made in its tool results
(`packages/domain/src/chat-attachments.ts` `generatedImages`) and shows each as a picture card
(`AttachmentCard`: a thumbnail that opens full size). A deleted conversation takes the pictures
its replies made (`attachmentIdsOf` reads `TOOL_CALL_RESULT` events too).

## Acceptance

`tests/image-generation.test.ts` (verdicts from records and tries, the keeping, drawing by
base64 and by URL, the kept attachment and the computer's copy, cards, file names).
End to end, two runs on a throwaway stack: a chat model whose gateway has no images endpoint
(the member must say she cannot draw), and `IMAGE_MODEL` pointed at a stand-in images gateway
in a container on the stack's network, so the drawing path runs through to the kept picture.
