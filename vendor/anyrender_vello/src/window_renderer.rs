use anyrender::{
    RegisterResourceErrorKind, RenderContext, ResourceId, WindowHandle, WindowRenderer,
};
use debug_timer::debug_timer;
use futures_channel::oneshot;
use kurbo::{Affine, Circle, Rect, RoundedRect, Stroke};
use peniko::{Color, Fill, Gradient, ImageData, Mix};
use rustc_hash::FxHashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use vello::{
    AaConfig, AaSupport, RenderParams, Renderer as VelloRenderer, RendererOptions,
    Scene as VelloScene,
};
use wgpu::{
    Adapter, Backend, Backends, CompositeAlphaMode, Device, DeviceType, Features, Instance, Limits,
    PipelineCache, PowerPreference, PresentMode, Queue, Surface, Texture, TextureFormat,
    TextureUsages,
};
use wgpu_context::{
    AlphaConversion, DeviceHandle, SurfaceRenderer, SurfaceRendererConfiguration,
    TextureConfiguration,
};

use crate::{DEFAULT_THREADS, VelloScenePainter};

struct ActiveRenderState {
    renderer: VelloRenderer,
    render_surface: SurfaceRenderer<'static>,
}

/// PATCH: everything the slow part of the initialisation produces. It is created on a
/// background thread; only the (fast) swap-chain configuration happens on the UI thread.
struct InitOutput {
    surface: Surface<'static>,
    device_handle: DeviceHandle,
    renderer: VelloRenderer,
    alpha_mode: CompositeAlphaMode,
    /// Keeps the window alive while the surface exists (dropped after `surface`).
    _window: Arc<dyn WindowHandle>,
}

/// PATCH: raw window/display handles, taken on the UI thread. winit only hands out window
/// handles on the thread that owns the window (Windows, macOS), but surface creation for
/// Vulkan/DX12 works from any thread.
struct RawHandles {
    window: wgpu::rwh::RawWindowHandle,
    display: wgpu::rwh::RawDisplayHandle,
}

// SAFETY: plain handle values (HWND, X11 window id, …); the window they refer to is kept
// alive by an `Arc` travelling with them.
unsafe impl Send for RawHandles {}

#[allow(clippy::large_enum_variant)]
enum RenderState {
    Suspended,
    Pending {
        receiver: oneshot::Receiver<Result<InitOutput, String>>,
    },
    Active(ActiveRenderState),
    /// PATCH: initialisation failed (no usable adapter, driver error, …).
    Failed(String),
}

#[derive(Clone)]
#[non_exhaustive]
pub struct VelloRendererOptions {
    pub features: Option<Features>,
    pub limits: Option<Limits>,
    pub base_color: Color,
    pub antialiasing_method: AaConfig,
    /// Alpha mode used when compositing the window surface.
    pub composite_alpha_mode: anyrender::CompositeAlphaMode,
    /// Cache that wgpu may reuse compiled pipelines from, avoiding shader
    /// compilation on start-up. Creating it, persisting its data and deciding
    /// when it is stale are all the caller's responsibility.
    pub pipeline_cache: Option<PipelineCache>,
    /// PATCH: directory for a persistent pipeline cache managed by the renderer (Vulkan
    /// only). Later starts reuse Vello's compiled compute pipelines.
    pub pipeline_cache_dir: Option<PathBuf>,
    /// PATCH: backends to consider (`WGPU_BACKEND` overrides). The default skips GL: Vello
    /// needs compute shaders and the GL backend is slow to initialise.
    pub backends: Backends,
    /// PATCH: adapter preference (`WGPU_POWER_PREF` overrides). Low power (integrated GPU)
    /// by default, like other browsers: it is fast enough for 2D and avoids waking up a
    /// discrete GPU.
    pub power_preference: PowerPreference,
    /// PATCH: accept software adapters (WARP, lavapipe, llvmpipe, SwiftShader). Vello's GPU
    /// pipeline on an emulated GPU is much slower than a real CPU renderer, so embedders
    /// normally fall back to one instead.
    pub allow_software_adapter: bool,
}

impl Default for VelloRendererOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl VelloRendererOptions {
    pub const fn new() -> Self {
        Self {
            features: None,
            limits: None,
            base_color: Color::WHITE,
            // PATCH: analytic area anti-aliasing (fastest; same approach as Skia/vello_cpu).
            antialiasing_method: AaConfig::Area,
            composite_alpha_mode: anyrender::CompositeAlphaMode::Auto,
            pipeline_cache: None,
            pipeline_cache_dir: None,
            backends: Backends::PRIMARY,
            power_preference: PowerPreference::LowPower,
            allow_software_adapter: true,
        }
    }

    pub fn features(self, features: Features) -> Self {
        Self {
            features: Some(features),
            ..self
        }
    }

    pub fn limits(self, limits: Limits) -> Self {
        Self {
            limits: Some(limits),
            ..self
        }
    }

    pub fn base_color(self, base_color: Color) -> Self {
        Self { base_color, ..self }
    }

    pub fn antialiasing_method(self, antialiasing_method: AaConfig) -> Self {
        Self {
            antialiasing_method,
            ..self
        }
    }

    pub fn composite_alpha_mode(
        self,
        composite_alpha_mode: anyrender::types::CompositeAlphaMode,
    ) -> Self {
        Self {
            composite_alpha_mode,
            ..self
        }
    }

    pub fn pipeline_cache(self, pipeline_cache: PipelineCache) -> Self {
        Self {
            pipeline_cache: Some(pipeline_cache),
            ..self
        }
    }

    /// PATCH: see [`Self::pipeline_cache_dir`].
    pub fn pipeline_cache_dir(self, dir: impl Into<PathBuf>) -> Self {
        Self {
            pipeline_cache_dir: Some(dir.into()),
            ..self
        }
    }

    /// PATCH: see [`Self::backends`].
    pub fn backends(self, backends: Backends) -> Self {
        Self { backends, ..self }
    }

    /// PATCH: see [`Self::power_preference`].
    pub fn power_preference(self, power_preference: PowerPreference) -> Self {
        Self {
            power_preference,
            ..self
        }
    }

    /// PATCH: see [`Self::allow_software_adapter`].
    pub fn allow_software_adapter(self, allow: bool) -> Self {
        Self {
            allow_software_adapter: allow,
            ..self
        }
    }
}

impl From<anyrender::RendererConfig> for VelloRendererOptions {
    fn from(config: anyrender::RendererConfig) -> Self {
        Self {
            base_color: config.base_color.unwrap_or(Color::WHITE),
            composite_alpha_mode: config.composite_alpha_mode.unwrap_or_default(),
            ..Default::default()
        }
    }
}

pub struct VelloWindowRenderer {
    // The fields MUST be in this order, so that the surface is dropped before the window
    // Window is cached even when suspended so that it can be reused when the app is resumed after being suspended
    render_state: RenderState,
    window_handle: Option<Arc<dyn WindowHandle>>,

    scene: VelloScene,
    config: VelloRendererOptions,

    // Resources
    texture_handles: FxHashMap<ResourceId, ImageData>,

    /// PATCH: latest requested surface size (also while initialisation is pending).
    size: (u32, u32),
    adapter_info: Option<wgpu::AdapterInfo>,
}

impl VelloWindowRenderer {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self::with_options(VelloRendererOptions::default())
    }

    pub fn with_options(config: impl Into<VelloRendererOptions>) -> Self {
        Self {
            render_state: RenderState::Suspended,
            config: config.into(),
            window_handle: None,
            scene: VelloScene::new(),
            texture_handles: FxHashMap::default(),
            size: (1, 1),
            adapter_info: None,
        }
    }

    pub fn current_device_handle(&self) -> Option<&DeviceHandle> {
        match &self.render_state {
            RenderState::Active(active) => Some(&active.render_surface.device_handle),
            _ => None,
        }
    }

    /// PATCH: why initialisation failed, if it did.
    pub fn init_error(&self) -> Option<&str> {
        match &self.render_state {
            RenderState::Failed(e) => Some(e),
            _ => None,
        }
    }

    /// PATCH: the adapter in use (after a successful [`WindowRenderer::complete_resume`]).
    pub fn adapter_info(&self) -> Option<&wgpu::AdapterInfo> {
        self.adapter_info.as_ref()
    }

    /// PATCH: start initialisation on a background thread and return immediately.
    ///
    /// Creating the wgpu instance, choosing an adapter, creating the device and compiling
    /// Vello's compute pipelines takes from ~100 ms to several seconds (first run, slow
    /// shader compilers); on the UI thread that freezes the window. `on_ready` is called
    /// from the background thread when [`WindowRenderer::complete_resume`] should be
    /// called on the UI thread. Initialisation can fail: `complete_resume` then returns
    /// `false` and [`Self::init_error`] says why.
    pub fn resume_in_background<F: FnOnce() + Send + 'static>(
        &mut self,
        window_handle: Arc<dyn WindowHandle>,
        width: u32,
        height: u32,
        on_ready: F,
    ) {
        if !matches!(
            self.render_state,
            RenderState::Suspended | RenderState::Failed(_)
        ) {
            return;
        }
        let (sender, receiver) = oneshot::channel();
        self.render_state = RenderState::Pending { receiver };
        self.window_handle = Some(window_handle.clone());
        self.size = (width.max(1), height.max(1));
        let config = self.config.clone();

        // Apple: the surface (CAMetalLayer) must be created on the main thread (cheap there).
        #[cfg(target_vendor = "apple")]
        let early = {
            let instance = create_instance(&config);
            let surface = instance
                .create_surface(window_handle.clone())
                .map_err(|e| format!("cannot create surface: {e}"));
            Some((instance, surface))
        };
        #[cfg(not(target_vendor = "apple"))]
        let early: Option<(Instance, Result<Surface<'static>, String>)> = None;

        // Elsewhere only the handles are taken here; instance and surface are created on
        // the background thread (creating a Vulkan instance can take 100+ ms).
        use wgpu::rwh::{HasDisplayHandle, HasWindowHandle};
        let raw = match (window_handle.window_handle(), window_handle.display_handle()) {
            (Ok(w), Ok(d)) => Ok(RawHandles {
                window: w.as_raw(),
                display: d.as_raw(),
            }),
            (Err(e), _) | (_, Err(e)) => Err(format!("window handle unavailable: {e}")),
        };
        let window_keepalive = window_handle.clone();

        let spawned = std::thread::Builder::new()
            .name("gpu-init".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    let (instance, surface) = match early {
                        Some((instance, surface)) => (instance, surface?),
                        None => {
                            let raw = raw?;
                            let instance = create_instance(&config);
                            // SAFETY: the handles belong to the window kept alive by
                            // `window_keepalive`, which is stored next to the surface (in
                            // `InitOutput`, then in the renderer) and dropped after it.
                            let surface = unsafe {
                                instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                                    raw_display_handle: Some(raw.display),
                                    raw_window_handle: raw.window,
                                })
                            }
                            .map_err(|e| format!("cannot create surface: {e}"))?;
                            (instance, surface)
                        }
                    };
                    pollster::block_on(init_gpu(instance, surface, &config, window_keepalive))
                }));
                let result = result.unwrap_or_else(|panic| {
                    Err(panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "GPU initialisation panicked".into()))
                });
                let _ = sender.send(result);
                on_ready();
            });
        if let Err(e) = spawned {
            self.render_state = RenderState::Failed(e.to_string());
        }
    }

    /// PATCH: configure the swap chain for a finished background initialisation.
    fn activate(&mut self, out: InitOutput) -> Result<(), String> {
        let (width, height) = self.size;
        let composite_alpha_mode = out.alpha_mode;

        #[cfg(not(target_vendor = "apple"))]
        let texture_config = Some(TextureConfiguration {
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
            format: TextureFormat::Rgba8Unorm,
            alpha_conversion: (composite_alpha_mode == CompositeAlphaMode::PreMultiplied)
                .then_some(AlphaConversion::Premultiply),
        });
        // TODO: Remove below once gfx-rs/wgpu#9896 gets fixed
        #[cfg(target_vendor = "apple")]
        let texture_config = Some(TextureConfiguration {
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
            format: TextureFormat::Rgba8Unorm,
            alpha_conversion: (composite_alpha_mode == CompositeAlphaMode::PostMultiplied
                || composite_alpha_mode == CompositeAlphaMode::PreMultiplied)
                .then_some(AlphaConversion::Premultiply),
        });

        let render_surface = SurfaceRenderer::new(
            out.surface,
            SurfaceRendererConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                formats: vec![TextureFormat::Rgba8Unorm, TextureFormat::Bgra8Unorm],
                width,
                height,
                present_mode: PresentMode::AutoVsync,
                desired_maximum_frame_latency: 2,
                alpha_mode: composite_alpha_mode,
                view_formats: vec![],
            },
            texture_config,
            out.device_handle,
        )
        .map_err(|e| format!("cannot configure surface: {e}"))?;
        self.adapter_info = Some(render_surface.device_handle.adapter.get_info());
        self.render_state = RenderState::Active(ActiveRenderState {
            renderer: out.renderer,
            render_surface,
        });
        Ok(())
    }
}

impl RenderContext for VelloWindowRenderer {
    fn try_register_custom_resource(
        &mut self,
        resource: Box<dyn std::any::Any>,
    ) -> Result<ResourceId, anyrender::RegisterResourceError> {
        let RenderState::Active(active) = &mut self.render_state else {
            return Err(RegisterResourceErrorKind::NotActive.into());
        };

        if let Ok(texture) = resource.downcast::<Texture>() {
            let id = ResourceId::new();
            self.texture_handles
                .insert(id, active.renderer.register_texture(*texture));
            Ok(id)
        } else {
            Err(anyrender::RegisterResourceErrorKind::UnsupportedResourceKind.into())
        }
    }

    fn unregister_resource(&mut self, resource_id: ResourceId) {
        let RenderState::Active(active) = &mut self.render_state else {
            return;
        };

        if let Some(handle) = self.texture_handles.remove(&resource_id) {
            active.renderer.unregister_texture(handle);
        }
    }

    fn renderer_specific_context(&self) -> Option<Box<dyn std::any::Any>> {
        match &self.render_state {
            RenderState::Active(active) => {
                Some(Box::new(active.render_surface.device_handle.clone()))
            }
            _ => None,
        }
    }
}

/// PATCH: an instance with only the configured backends (no GL by default).
fn create_instance(config: &VelloRendererOptions) -> Instance {
    Instance::new(wgpu::InstanceDescriptor {
        backends: Backends::from_env().unwrap_or(config.backends),
        flags: wgpu::InstanceFlags::from_build_config().with_env(),
        backend_options: wgpu::BackendOptions::from_env_or_default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        display: None,
    })
}

/// PATCH: explicit adapter choice: must be able to present to the window; hardware GPUs
/// before software rasterizers; integrated before discrete for low power (and the other
/// way round for high performance); Vulkan/Metal before DX12 (no FXC shader compiles,
/// persistent pipeline cache).
async fn select_adapter(
    instance: &Instance,
    surface: &Surface<'_>,
    config: &VelloRendererOptions,
) -> Result<Adapter, String> {
    let mut adapters: Vec<Adapter> = instance
        .enumerate_adapters(Backends::all())
        .await
        .into_iter()
        .filter(|a| a.is_surface_supported(surface))
        .collect();
    if let Ok(name) = std::env::var("WGPU_ADAPTER_NAME") {
        let name = name.to_lowercase();
        adapters.retain(|a| a.get_info().name.to_lowercase().contains(&name));
    }
    let preference = PowerPreference::from_env().unwrap_or(config.power_preference);
    let device_rank = |t: DeviceType| -> u8 {
        match (t, preference) {
            (DeviceType::DiscreteGpu, PowerPreference::HighPerformance) => 0,
            (DeviceType::IntegratedGpu, PowerPreference::HighPerformance) => 1,
            (DeviceType::IntegratedGpu, _) => 0,
            (DeviceType::DiscreteGpu, _) => 1,
            (DeviceType::Other, _) => 2,
            (DeviceType::VirtualGpu, _) => 3,
            (DeviceType::Cpu, _) => 4,
        }
    };
    let backend_rank = |b: Backend| -> u8 {
        match b {
            Backend::Vulkan | Backend::Metal => 0,
            Backend::Dx12 => 1,
            _ => 2,
        }
    };
    adapters.sort_by_key(|a| {
        let info = a.get_info();
        (device_rank(info.device_type), backend_rank(info.backend))
    });
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| "no GPU adapter can present to this window".to_string())?;
    let info = adapter.get_info();
    if info.device_type == DeviceType::Cpu && !config.allow_software_adapter {
        return Err(format!(
            "only a software rasterizer is available ({} via {:?})",
            info.name, info.backend
        ));
    }
    Ok(adapter)
}

fn choose_alpha_mode(
    requested: anyrender::CompositeAlphaMode,
    mut alpha_modes: Vec<CompositeAlphaMode>,
) -> Result<CompositeAlphaMode, String> {
    let composite_alpha_mode = match requested {
        anyrender::CompositeAlphaMode::Auto => CompositeAlphaMode::Auto,
        anyrender::CompositeAlphaMode::Opaque => CompositeAlphaMode::Opaque,
        anyrender::CompositeAlphaMode::Transparent => {
            #[cfg(target_vendor = "apple")]
            {
                // wgpu is lying in apple's case it uses PreMultiplied in reality
                // (do not modify shaders for PostMultiplied)
                CompositeAlphaMode::PostMultiplied
            }
            #[cfg(not(target_vendor = "apple"))]
            {
                CompositeAlphaMode::PreMultiplied
            }
        }
    };
    if alpha_modes.contains(&composite_alpha_mode) {
        return Ok(composite_alpha_mode);
    }
    let rank = |m: &CompositeAlphaMode| match *m {
        CompositeAlphaMode::PreMultiplied => 0,
        CompositeAlphaMode::PostMultiplied => 1,
        CompositeAlphaMode::Opaque | CompositeAlphaMode::Inherit | CompositeAlphaMode::Auto => 2,
    };
    alpha_modes.sort_unstable_by_key(rank);
    alpha_modes
        .first()
        .copied()
        .ok_or_else(|| "surface didn't report any alpha modes".to_string())
}

/// PATCH: the slow part of the initialisation (runs on the `gpu-init` thread).
async fn init_gpu(
    instance: Instance,
    surface: Surface<'static>,
    config: &VelloRendererOptions,
    window: Arc<dyn WindowHandle>,
) -> Result<InitOutput, String> {
    let adapter = select_adapter(&instance, &surface, config).await?;
    let info = adapter.get_info();

    let requested_features =
        config.features.unwrap_or_default() | Features::CLEAR_TEXTURE | Features::PIPELINE_CACHE;
    let required_features = requested_features & adapter.features();
    let required_limits = config.limits.clone().unwrap_or_else(|| Limits {
        // Fix iOS simulator
        max_inter_stage_shader_variables: 15,
        ..Limits::default()
    });
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features,
            required_limits,
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            trace: wgpu::Trace::default(),
            experimental_features: wgpu::ExperimentalFeatures::default(),
        })
        .await
        .map_err(|e| format!("cannot create device on {}: {e}", info.name))?;

    let alpha_mode = choose_alpha_mode(
        config.composite_alpha_mode,
        surface.get_capabilities(&adapter).alpha_modes,
    )?;

    let persistent = match &config.pipeline_cache {
        Some(_) => None,
        None => PersistentPipelineCache::open(&device, &info, config.pipeline_cache_dir.as_deref()),
    };
    let pipeline_cache = config
        .pipeline_cache
        .clone()
        .or_else(|| persistent.as_ref().map(|p| p.cache.clone()));

    let antialiasing_method = config.antialiasing_method;
    let mut renderer = VelloRenderer::new(
        &device,
        RendererOptions {
            // PATCH: compile only the pipelines for the configured AA mode. Compiling
            // all three variants roughly triples shader compilation at startup.
            antialiasing_support: match antialiasing_method {
                AaConfig::Area => AaSupport::area_only(),
                AaConfig::Msaa8 => AaSupport {
                    area: false,
                    msaa8: true,
                    msaa16: false,
                },
                AaConfig::Msaa16 => AaSupport {
                    area: false,
                    msaa8: false,
                    msaa16: true,
                },
            },
            use_cpu: false,
            num_init_threads: DEFAULT_THREADS,
            pipeline_cache,
        },
    )
    .map_err(|e| format!("cannot create Vello renderer: {e}"))?;

    warm_up(&mut renderer, &device, &queue, antialiasing_method);
    if let Some(p) = persistent {
        p.save();
    }

    Ok(InitOutput {
        surface,
        device_handle: DeviceHandle {
            instance,
            adapter,
            device,
            queue,
        },
        renderer,
        alpha_mode,
        _window: window,
    })
}

/// PATCH: render a tiny scene once so that first-use costs (buffer allocation, lazy
/// driver compilation of the pipelines) are paid here and not in the first real frame.
fn warm_up(renderer: &mut VelloRenderer, device: &Device, queue: &Queue, aa: AaConfig) {
    const SIZE: u32 = 64;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("vello warm-up"),
        size: wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let mut scene = VelloScene::new();
    let blue = Color::from_rgb8(0x0b, 0x57, 0xd0);
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        blue,
        None,
        &RoundedRect::new(4.0, 4.0, 60.0, 60.0, 6.0),
    );
    scene.push_layer(
        Fill::NonZero,
        Mix::Normal,
        0.5,
        Affine::IDENTITY,
        &Rect::new(8.0, 8.0, 56.0, 56.0),
    );
    let gradient = Gradient::new_linear((0.0, 0.0), (64.0, 0.0))
        .with_stops([Color::WHITE, Color::BLACK]);
    scene.fill(
        Fill::EvenOdd,
        Affine::IDENTITY,
        &gradient,
        None,
        &Rect::new(0.0, 0.0, 64.0, 24.0),
    );
    scene.stroke(
        &Stroke::new(1.5),
        Affine::IDENTITY,
        Color::BLACK,
        None,
        &Circle::new((32.0, 32.0), 20.0),
    );
    scene.pop_layer();
    let _ = renderer.render_to_texture(
        device,
        queue,
        &scene,
        &view,
        &RenderParams {
            base_color: Color::WHITE,
            width: SIZE,
            height: SIZE,
            antialiasing_method: aa,
        },
    );
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
}

/// PATCH: a wgpu pipeline cache stored on disk (one file per adapter/driver).
struct PersistentPipelineCache {
    cache: PipelineCache,
    path: PathBuf,
    loaded_len: Option<usize>,
}

impl PersistentPipelineCache {
    fn open(device: &Device, info: &wgpu::AdapterInfo, dir: Option<&Path>) -> Option<Self> {
        let dir = dir?;
        if !device.features().contains(Features::PIPELINE_CACHE) {
            return None;
        }
        let key = wgpu::util::pipeline_cache_key(info)?;
        let path = dir.join(key);
        let data = std::fs::read(&path).ok();
        // SAFETY: the file is only ever written by `save` below with data from
        // `PipelineCache::get_data`. wgpu validates it (header, length, hash, adapter and
        // driver version) and `fallback: true` starts with an empty cache when it does not
        // match.
        let cache = unsafe {
            device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                label: Some("vello pipeline cache"),
                data: data.as_deref(),
                fallback: true,
            })
        };
        Some(Self {
            cache,
            path,
            loaded_len: data.map(|d| d.len()),
        })
    }

    fn save(&self) {
        let Some(data) = self.cache.get_data() else {
            return;
        };
        if self.loaded_len == Some(data.len()) {
            return;
        }
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("tmp");
        if std::fs::write(&tmp, &data).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

impl WindowRenderer for VelloWindowRenderer {
    type ScenePainter<'a>
        = VelloScenePainter<'a, 'a>
    where
        Self: 'a;

    fn is_active(&self) -> bool {
        matches!(self.render_state, RenderState::Active { .. })
    }

    fn is_pending(&self) -> bool {
        matches!(self.render_state, RenderState::Pending { .. })
    }

    /// Blocking variant of [`VelloWindowRenderer::resume_in_background`]: `on_ready` runs
    /// before this returns.
    fn resume<F: FnOnce() + 'static>(
        &mut self,
        window_handle: Arc<dyn WindowHandle>,
        width: u32,
        height: u32,
        on_ready: F,
    ) {
        // Each `resume` must be preceded by `suspend` (or be the first call after
        // construction).
        if !matches!(
            self.render_state,
            RenderState::Suspended | RenderState::Failed(_)
        ) {
            return;
        }
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        self.resume_in_background(window_handle, width, height, move || {
            let _ = done_tx.send(());
        });
        let _ = done_rx.recv();
        self.complete_resume();
        on_ready();
    }

    fn complete_resume(&mut self) -> bool {
        let received = match &mut self.render_state {
            RenderState::Active { .. } => return true,
            RenderState::Suspended | RenderState::Failed(_) => return false,
            RenderState::Pending { receiver } => receiver.try_recv(),
        };
        match received {
            Ok(Some(Ok(output))) => match self.activate(output) {
                Ok(()) => true,
                Err(e) => {
                    self.render_state = RenderState::Failed(e);
                    false
                }
            },
            Ok(Some(Err(e))) => {
                self.render_state = RenderState::Failed(e);
                false
            }
            // Still initialising.
            Ok(None) => false,
            Err(_) => {
                self.render_state = RenderState::Failed("GPU initialisation was aborted".into());
                false
            }
        }
    }

    fn suspend(&mut self) {
        if let RenderState::Active(active) = &mut self.render_state {
            // Unregister all textures on suspend
            for (_id, handle) in self.texture_handles.drain() {
                active.renderer.unregister_texture(handle);
            }
        }
        self.render_state = RenderState::Suspended;
    }

    fn set_size(&mut self, width: u32, height: u32) {
        self.size = (width.max(1), height.max(1));
        if let RenderState::Active(active) = &mut self.render_state {
            active.render_surface.resize(width, height);
        };
    }

    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, draw_fn: F) {
        let RenderState::Active(state) = &mut self.render_state else {
            return;
        };

        let render_surface = &mut state.render_surface;

        debug_timer!(timer, feature = "log_frame_times");

        // Regenerate the vello scene
        draw_fn(&mut VelloScenePainter {
            inner: &mut self.scene,
            renderer: Some(&mut state.renderer),
            device_handle: Some(&render_surface.device_handle),
            texture_handles: Some(&mut self.texture_handles),
        });
        timer.record_time("cmd");

        let Ok(texture_view) = render_surface.target_texture_view() else {
            // Skip frame in case of error trying to get current surface texture
            render_surface.clear_surface_texture();
            return;
        };

        for handle in self.texture_handles.values() {
            state.renderer.mark_override_image_dirty(handle);
        }

        state
            .renderer
            .render_to_texture(
                render_surface.device(),
                render_surface.queue(),
                &self.scene,
                &texture_view,
                &RenderParams {
                    base_color: self.config.base_color,
                    width: render_surface.config.width,
                    height: render_surface.config.height,
                    antialiasing_method: self.config.antialiasing_method,
                },
            )
            .expect("failed to render to texture");
        timer.record_time("render");

        drop(texture_view);

        if render_surface.maybe_blit_and_present().is_err() {
            return;
        }
        timer.record_time("present");

        render_surface
            .device()
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();

        timer.record_time("wait");
        timer.print_times("vello: ");

        // Empty the Vello scene (memory optimisation)
        self.scene.reset();
    }
}
