import gradio as gr
import folium
import networkx as nx
from scipy.spatial.distance import pdist, squareform
import json
import html
import requests

# --- 1. HTML Peta Leaflet + Geocoder (Sistem Penyimpanan Internal) ---
map_html = """
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.css" />
    <script src="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.js"></script>
    <style>body, html { margin: 0; padding: 0; height: 100%; }</style>
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
            placeholder: "Cari lokasi rumah..."
        }).on('markgeocode', function(e) {
            map.setView(e.geocode.center, 16);
        }).addTo(map);
        
        window.userCoords = [];
        window.markers = [];
        
        map.on('click', function(e) {
            var lat = e.latlng.lat;
            var lng = e.latlng.lng;
            var marker = L.marker([lat, lng]).addTo(map)
                .bindPopup("Destinasi " + (window.userCoords.length + 1)).openPopup();
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

# --- 2. Javascript Interceptor untuk Tombol Gradio ---
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

# --- 3. Fungsi Python (TSP Solver + OSRM Real Routing) ---
def solve_efficient_route(coords_json):
    try:
        if not coords_json or coords_json.strip() == "" or coords_json == "[]":
            return None, "⚠️ Peta masih kosong. Silakan cari lokasi dan klik minimal 2 titik."
        
        coords = json.loads(coords_json)
        n = len(coords)
        
        if n < 2:
            return None, "⚠️ Dibutuhkan minimal 2 titik untuk membuat rute."
            
        # Algoritma TSP (menggunakan Euclidean distance sebagai aproksimasi urutan)
        if n == 2:
            route_indices = [0, 1]
        else:
            dist_matrix = squareform(pdist(coords))
            G = nx.from_numpy_array(dist_matrix)
            route_indices = nx.approximation.traveling_salesman_problem(G, cycle=False)
        
        ordered_coords = [coords[idx] for idx in route_indices]
        m = folium.Map(location=ordered_coords[0], zoom_start=14)
        route_names = []
        
        # 3.1 Penempatan Marker dengan Label Permanen
        for step, idx in enumerate(route_indices):
            lat_lon = coords[idx]
            
            if step == 0: 
                order_txt = "🚀 START"
                color = "green"
            elif step == len(route_indices)-1: 
                order_txt = "🏁 FINISH"
                color = "red"
            else: 
                order_txt = f"📍 Ke-{step+1}"
                color = "blue"
            
            route_names.append(f"{step+1}. Lokasi {idx+1}")
            
            # tooltip dengan permanent=True membuat label selalu terlihat
            folium.Marker(
                location=lat_lon,
                icon=folium.Icon(color=color, icon="info-sign"),
                tooltip=folium.Tooltip(f"<b>{order_txt}</b>", permanent=True, direction="top")
            ).add_to(m)

        # 3.2 Menarik Garis Rute Nyata menggunakan API OSRM
        # Format OSRM: lon,lat;lon,lat;...
        osrm_coords = ";".join([f"{lon},{lat}" for lat, lon in ordered_coords])
        osrm_url = f"http://router.project-osrm.org/route/v1/driving/{osrm_coords}?overview=full&geometries=geojson"
        
        try:
            # Panggil API OSRM
            response = requests.get(osrm_url, timeout=10)
            data = response.json()
            
            if data.get("code") == "Ok":
                # Jika berhasil, gambar rute jalan raya (GeoJSON)
                route_geo = data["routes"][0]["geometry"]
                folium.GeoJson(
                    route_geo,
                    name='Rute Jalan',
                    style_function=lambda x: {'color': '#3388ff', 'weight': 5, 'opacity': 0.8}
                ).add_to(m)
            else:
                raise Exception("OSRM Response bukan Ok")
                
        except Exception as e:
            # Fallback (Rencana B): Jika API OSRM error/down, kembali gambar garis lurus
            folium.PolyLine(ordered_coords, color="#2ecc71", weight=5, opacity=0.8, dash_array="10").add_to(m)
            print(f"Fallback to linear route due to OSRM error: {e}")
        
        return m._repr_html_(), f"✅ Rute Optimal Ditemukan:\n{' ➡️ '.join(route_names)}"
        
    except Exception as e:
        return None, f"❌ Terjadi kesalahan proses: {str(e)}"

# --- 4. Antarmuka UI ---
with gr.Blocks(theme=gr.themes.Default(primary_hue="emerald")) as app:
    gr.Markdown("# 🌙 Peta Silaturahmi Lebaran Efisien")
    
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### 1️⃣ Cari & Pilih Lokasi di Peta\nGunakan ikon kaca pembesar (🔍) untuk mencari alamat, lalu **klik** lokasi tersebut.")
            gr.HTML(iframe_html)
            
            dummy_input = gr.Textbox(visible=False)
            
            with gr.Row():
                clear_btn = gr.Button("🗑️ Reset Map", variant="secondary")
                submit_btn = gr.Button("🚀 Hitung Rute Tercepat", variant="primary")
                
        with gr.Column(scale=1):
            gr.Markdown("### 2️⃣ Hasil Rute Optimal")
            output_map = gr.HTML(label="Peta Rute")
            output_text = gr.Textbox(label="Urutan Kunjungan", lines=4)

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