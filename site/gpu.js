// Full-canvas fragment shader on WebGPU. Resolves to null when WebGPU is unavailable.
// The shader declares `struct U` and `@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f`.
export async function shader(canvas, wgsl, floats) {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    const device = await adapter?.requestDevice()
    const context = device && canvas.getContext("webgpu")
    if (!context) return null
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: "premultiplied" })
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
${wgsl}`,
    })
    const info = await module.getCompilationInfo?.()
    if (info?.messages.some((m) => m.type === "error")) {
      console.warn(info.messages.map((m) => m.message).join("\n"))
      return null
    }
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })
    const buffer = device.createBuffer({ size: Math.ceil((floats * 4) / 16) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] })
    return (data) => {
      if (!canvas.width || !canvas.height) return
      device.queue.writeBuffer(buffer, 0, data)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
    }
  } catch (error) {
    console.warn(error)
    return null
  }
}
