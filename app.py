import gradio as gr
import folium
import networkx as nx
from scipy.spatial.distance import pdist, squareform
import json
import html
import requests

# --- 1. HTML Peta Leaflet + Geocoder (UI/UX Input Diperbaiki) ---
map_html = """
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.css" />
    <script src="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.js"></script>
    <style>
        body, html { margin: 0; padding: 0; height: 100%; }
        /* Mempertebal font tooltip agar lebih jelas dibaca */
        .leaflet-tooltip { font-weight: bold; font-size: 13px; }
    </style>
</head>
<body>
    <div id="map" style="width: 100vw; height: 100vh;"></div>
    <script>
        var map = L.map('map').setView([-6.8400, 107.4780], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
        }).addTo(map);

        L.Control.geocoder({
            defaultMarkGeocode: false,
            placeholder: "Cari lokasi rumah kerabat..."
        }).on('markgeocode', function(e) {
            map.setView(e.geocode.center, 16);
        }).addTo(map);
        
        window.userCoords = [];
        window.markers = [];
        
        map.on('click', function(e) {
            var lat = e.latlng.lat;
            var lng = e.latlng.lng;
            var id = window.userCoords.length + 1;
            
            // Penamaan konsisten di Input Map dengan Tooltip Permanen
            var labelText = (id === 1) ? "🚀 START (Lokasi 1)" : "Lokasi " + id;
            var labelColor = (id === 1) ? "green" : "blue";
            
            // Membuat marker kustom berwarna (hijau untuk start, biru untuk lainnya)
            var markerIcon = new L.Icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-' + labelColor + '.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            });

            var marker = L.marker([lat, lng], {icon: markerIcon}).addTo(map)
                .bindTooltip(labelText, {permanent: true, direction: "top", offset: [0, -40]}).openTooltip();
                
            window.markers.push(marker);
            window.userCoords.push([lat, lng]);
        });

        window.getCoords = function() { return JSON.stringify(window.userCoords); };

        window.resetMap = function() {
            window.markers.forEach(m => map.removeLayer(m));
            window.markers = [];
            window.userCoords = [];
        };
    </script>
</body>
</html>
"""

safe_html = html.escape(map_html)
iframe_html = f'<iframe id="leaflet_iframe" srcdoc="{safe_html}" width="100%" height="450px" style="border: 1px solid #ddd; border-radius: 8px;"></iframe>'

# --- 2. Javascript Bridge ---
js_get_coords = """
function(dummy) {
    var iframe = document.getElementById('leaflet_iframe');
    if (iframe && iframe.contentWindow && iframe.contentWindow.getCoords) {
        return iframe.contentWindow.getCoords();
    }
    return "[]";
}
"""

js_reset_map = """
function() {
    var iframe = document.getElementById('leaflet_iframe');
    if (iframe && iframe.contentWindow && iframe.contentWindow.resetMap) {
        iframe.contentWindow.resetMap();
    }
    return "";
}
"""

# --- 3. Kalkulasi Logika & Penamaan Konsisten ---
def solve_efficient_route(coords_json):
    try:
        if not coords_json or coords_json.strip() == "" or coords_json == "[]":
            return None, "⚠️ Peta masih kosong. Silakan cari lokasi dan klik minimal 2 titik."
        
        coords = json.loads(coords_json)
        n = len(coords)
        
        if n < 2:
            return None, "⚠️ Dibutuhkan minimal 2 titik untuk membuat rute."
            
        if n == 2:
            route_indices = [0, 1]
        else:
            # Kalkulasi jarak
            dist_matrix = squareform(pdist(coords))
            G = nx.from_numpy_array(dist_matrix)
            
            # Kita buat siklus (loop tertutup) terlebih dahulu
            cycle_route = nx.approximation.traveling_salesman_problem(G, cycle=True)
            
            # Buang node terakhir karena sama dengan node pertama di cycle=True
            cycle_route = cycle_route[:-1] 
            
            # Cari di mana posisi indeks 0 (Titik START/Rumah yang diklik pertama)
            idx_zero = cycle_route.index(0)
            
            # Lakukan Rotasi Array agar urutan selalu dimulai dari index 0
            route_indices = cycle_route[idx_zero:] + cycle_route[:idx_zero]

        ordered_coords = [coords[idx] for idx in route_indices]
        m = folium.Map(location=ordered_coords[0], zoom_start=14)
        
        route_text_list = []
        
        # Penamaan yang Rapi untuk Map Output
        for step, original_idx in enumerate(route_indices):
            lat_lon = coords[original_idx]
            lokasi_asli = original_idx + 1
            
            if step == 0: 
                order_txt = "🚀 START (Lokasi 1)"
                color = "green"
                text_result = "START (Lokasi 1)"
            elif step == len(route_indices)-1: 
                order_txt = f"🏁 FINISH (Lokasi {lokasi_asli})"
                color = "red"
                text_result = f"FINISH (Lokasi {lokasi_asli})"
            else: 
                order_txt = f"📍 Ke-{step+1} (Lokasi {lokasi_asli})"
                color = "blue"
                text_result = f"Lokasi {lokasi_asli}"
            
            route_text_list.append(text_result)
            
            folium.Marker(
                location=lat_lon,
                icon=folium.Icon(color=color, icon="info-sign"),
                tooltip=folium.Tooltip(f"<b>{order_txt}</b>", permanent=True, direction="top")
            ).add_to(m)

        # Coba tarik garis rute nyata via OSRM
        osrm_coords = ";".join([f"{lon},{lat}" for lat, lon in ordered_coords])
        osrm_url = f"http://router.project-osrm.org/route/v1/driving/{osrm_coords}?overview=full&geometries=geojson"
        
        try:
            response = requests.get(osrm_url, timeout=10)
            data = response.json()
            if data.get("code") == "Ok":
                route_geo = data["routes"][0]["geometry"]
                folium.GeoJson(route_geo, name='Rute Jalan', style_function=lambda x: {'color': '#3388ff', 'weight': 5, 'opacity': 0.8}).add_to(m)
            else:
                raise Exception("OSRM Response bukan Ok")
        except Exception:
            # Fallback garis lurus
            folium.PolyLine(ordered_coords, color="#2ecc71", weight=5, opacity=0.8, dash_array="10").add_to(m)
        
        final_text = " ➡️\n".join([f"{i+1}. {text}" for i, text in enumerate(route_text_list)])
        return m._repr_html_(), f"✅ Rute Paling Efisien:\n\n{final_text}"
        
    except Exception as e:
        return None, f"❌ Terjadi kesalahan sistem: {str(e)}"

# --- 4. Antarmuka UI Gradio ---
with gr.Blocks(theme=gr.themes.Default(primary_hue="emerald")) as app:
    gr.Markdown("# 🌙 Peta Silaturahmi Lebaran Efisien by ALIF TOWEW (menggunakan TSP)")
    
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### 1️⃣ Cari & Pilih Lokasi\nTitik pertama yang diklik otomatis menjadi **START (Rumah Anda)**. Klik selanjutnya adalah rumah kerabat.")
            gr.HTML(iframe_html)
            
            dummy_input = gr.Textbox(visible=False)
            
            with gr.Row():
                clear_btn = gr.Button("🗑️ Reset Map", variant="secondary")
                submit_btn = gr.Button("🚀 Hitung Rute Tercepat", variant="primary")
                
        with gr.Column(scale=1):
            gr.Markdown("### 2️⃣ Hasil Rute Optimal\nPerhatikan urutan **Ke-X**, itu adalah jalur tercepat yang harus Anda tempuh.")
            output_map = gr.HTML(label="Peta Rute")
            output_text = gr.Textbox(label="Urutan Kunjungan (Berdasarkan Lokasi Asli)", lines=8)

    submit_btn.click(
        fn=solve_efficient_route, 
        inputs=dummy_input, 
        outputs=[output_map, output_text], 
        js=js_get_coords
    )
    
    clear_btn.click(
        fn=None, 
        inputs=None, 
        outputs=dummy_input, 
        js=js_reset_map
    )

if __name__ == "__main__":
    app.launch()
