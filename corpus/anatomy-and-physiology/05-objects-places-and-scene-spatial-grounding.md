# Objects, Places, and Scene Spatial Grounding in Vision AI

Principles and spatial representations for locating, categorizing, and reasoning about
man-made objects, architectural environments, natural places, and physical materials.

## 1. Object Spatial Decomposition and Affordances

Objects are represented hierarchically through functional components, structural bounding volumes,
and ergonomic contact surfaces:

### A. Mechanical Tools and Instruments
- **Grip / Handle**: Primary interface designed for human hand grasping (thenar/finger contact).
- **Shaft / Shank**: Connective load-bearing member transferring mechanical torque or force.
- **Functional Tip / Head / Working Edge**: Blade, hammerhead, lens, sensor, or jaw performing the operative action.
- **Spatial Bounding**: Characterized by high aspect-ratio orientation vectors aligned with user intent.

### B. Vehicles and Transportation
- **Chassis & Wheels / Contact Elements**: Low-elevation horizontal base establishing ground plane interaction.
- **Enclosure / Cabin**: Central volumetric compartment housing human occupants or payload.
- **Apertures**: Glazed windshields, side windows, doors, and functional cowlings.
- **Directional Indicators**: Headlights/taillights defining vehicle heading vector.

### C. Electronic Devices and Interfaces
- **Active Display Matrix**: Planar rectangular emissive surface displaying graphical UI.
- **Bezel & Casing**: Structural perimeter bounding active visual elements.
- **Sensors & Controls**: Camera apertures, tactile buttons, microphones, and connectors.

### D. Furniture and Structural Elements
- **Seating & Surfaces**: Horizontal planes positioned at ergonomic elevations (tabletop ~75 cm, seat ~45 cm).
- **Supports**: Vertical or canted legs, pedestals, and backrests distributing gravitational load to the floor.

## 2. Places and Environmental Topologies

Spatial intelligence segments environments into distinct perspective and volumetric zones:

### A. Indoor Architectural Environments
- **Floor Plane**: Horizontal base with defined material (hardwood, tile, carpet) establishing contact shadows and perspective baseline.
- **Wall Surfaces & Corners**: Vertical boundaries creating 1-point or 2-point perspective convergence lines.
- **Ceiling & Lighting**: Overhead boundary containing recessed fixtures, chandeliers, or diffuse skylights.
- **Apertures**: Doors, hallways, and windows connecting contiguous volumetric zones and introducing external illumination.

### B. Outdoor Natural Environments
- **Terrain Ground Surface**: Non-planar contours (hills, sand, grass, rocks, water).
- **Horizon Line**: Boundary separating planetary surface from atmospheric dome; key calibration line for camera pitch and elevation.
- **Sky Vault / Atmosphere**: Dome displaying directional sunlight, clouds, and Rayleigh scattering depth cues (aerial perspective).

### C. Depth Zones in Scene Parsing
- **Foreground (0.0 to 0.2 Normalized Depth)**: High-detail focal subjects, hand interactions, immediate obstacles.
- **Midground (0.2 to 0.6 Normalized Depth)**: Room layout, primary furniture, secondary subjects, vehicles, pathways.
- **Background (0.6 to 1.0 Normalized Depth)**: Distant walls, outdoor vistas, mountains, skyline, horizon.

## 3. Physical Things and Materials

Material perception relies on surface physics:
- **Human Skin**: Complex subsurface scattering (translucency), micro-relief, melanin gradients.
- **Textiles**: Anisotropic grazing reflections, micro-roughness, weave density, gravity-conforming folds.
- **Metals & Glass**: Specular reflection, metallic fresnel falloff, refractive transparency, caustics.
- **Organic Matter**: Wood grain, foliage chlorophyll absorption, stone porosity, water specular reflection.
