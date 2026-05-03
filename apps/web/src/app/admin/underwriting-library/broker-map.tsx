'use client';

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapMarker {
  id: string;
  assetType: string;
  year: number;
  city: string;
  state: string;
  lat: number;
  lng: number;
  color: string;
}

export interface MarketCluster {
  city: string;
  state: string;
  assetTypes: string[];
  count: number;
  lat: number;
  lng: number;
}

interface BrokerMapProps {
  markers: MapMarker[];
  showHeatmap: boolean;
  onClusterClick: (cluster: MarketCluster) => void;
  selectedKey: string | null;
}

const ASSET_CLASS_COLORS: Record<string, string> = {
  office: '#3B82F6', multifamily: '#10B981', retail: '#F97316', industrial: '#8B5CF6',
  hotel: '#EF4444', self_storage: '#6B7280', mixed_use: '#EC4899', manufactured_housing: '#14B8A6',
};

function createMarketIcon(count: number, selected: boolean): L.DivIcon {
  const size = selected ? (count > 20 ? 48 : count > 5 ? 40 : 32) : (count > 20 ? 42 : count > 5 ? 34 : 26);
  const border = selected ? 'border: 2px solid #F59E0B; box-shadow: 0 0 10px rgba(245,158,11,0.5);' : 'border: 2px solid rgba(255,255,255,0.5);';
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:rgba(16,185,129,0.85);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;${border}box-shadow:0 2px 8px rgba(0,0,0,0.3);">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function BrokerMap({ markers, showHeatmap, onClusterClick, selectedKey }: BrokerMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const heatLayerRef = useRef<L.LayerGroup | null>(null);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [39.8, -98.5],
      zoom: 4,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;
    markersLayerRef.current = L.layerGroup().addTo(map);
    heatLayerRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update markers — aggregate to market clusters (city + state)
  useEffect(() => {
    if (!mapRef.current || !markersLayerRef.current) return;
    markersLayerRef.current.clearLayers();
    if (markers.length === 0) return;

    // Group by city + state (market-level)
    const marketGroups = new Map<string, { markers: MapMarker[]; lat: number; lng: number }>();
    for (const m of markers) {
      const key = `${m.city}_${m.state}`;
      const existing = marketGroups.get(key);
      if (existing) {
        existing.markers.push(m);
        // Average lat/lng
        existing.lat = (existing.lat * (existing.markers.length - 1) + m.lat) / existing.markers.length;
        existing.lng = (existing.lng * (existing.markers.length - 1) + m.lng) / existing.markers.length;
      } else {
        marketGroups.set(key, { markers: [m], lat: m.lat, lng: m.lng });
      }
    }

    for (const [key, group] of marketGroups) {
      const count = group.markers.length;
      const city = group.markers[0].city;
      const state = group.markers[0].state;
      const assetTypes = [...new Set(group.markers.map((m) => m.assetType))];
      const isSelected = selectedKey === key;

      const icon = createMarketIcon(count, isSelected);
      const leafletMarker = L.marker([group.lat, group.lng], { icon });

      // Market-level tooltip — NO deal names
      const assetLabels = assetTypes.map((a) => capitalize(a.replace('_', ' '))).join(', ');
      const years = group.markers.map((m) => m.year);
      const minY = Math.min(...years);
      const maxY = Math.max(...years);
      const yearStr = minY === maxY ? `${minY}` : `${minY}–${maxY}`;

      leafletMarker.bindTooltip(
        `<div style="font-family:Inter,system-ui,sans-serif;font-size:11px;line-height:1.5;min-width:160px;">
          <div style="font-weight:600;margin-bottom:2px;font-size:12px;">${city}, ${state}</div>
          <div style="color:#9CA3AF;">${count} underwriting${count !== 1 ? 's' : ''}</div>
          <div style="color:#9CA3AF;">${assetLabels}</div>
          <div style="color:#9CA3AF;">${yearStr}</div>
          <div style="color:#F59E0B;margin-top:4px;font-size:10px;">Click for Market Intelligence</div>
        </div>`,
        { direction: 'top', offset: [0, -8], className: 'broker-map-tooltip' }
      );

      const cluster: MarketCluster = { city, state, assetTypes, count, lat: group.lat, lng: group.lng };
      leafletMarker.on('click', () => onClusterClick(cluster));
      leafletMarker.addTo(markersLayerRef.current!);
    }
  }, [markers, selectedKey, onClusterClick]);

  // Update heatmap overlay
  useEffect(() => {
    if (!mapRef.current || !heatLayerRef.current) return;
    heatLayerRef.current.clearLayers();

    if (!showHeatmap || markers.length === 0) return;

    const stateCounts = new Map<string, { lat: number; lng: number; count: number }>();
    for (const m of markers) {
      const key = m.state;
      const existing = stateCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        stateCounts.set(key, { lat: m.lat, lng: m.lng, count: 1 });
      }
    }

    for (const [, data] of stateCounts) {
      const radius = Math.min(Math.max(data.count * 15000, 30000), 200000);
      const opacity = Math.min(0.15 + data.count * 0.03, 0.45);
      L.circle([data.lat, data.lng], {
        radius,
        color: 'transparent',
        fillColor: '#F59E0B',
        fillOpacity: opacity,
      }).addTo(heatLayerRef.current!);
    }
  }, [markers, showHeatmap]);

  return (
    <>
      <style jsx global>{`
        .broker-map-tooltip {
          background: #111827 !important;
          border: 1px solid #1F2937 !important;
          border-radius: 4px !important;
          color: #E5E7EB !important;
          padding: 8px 10px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
        }
        .broker-map-tooltip::before {
          border-top-color: #1F2937 !important;
        }
        .leaflet-control-zoom a {
          background: #111827 !important;
          color: #E5E7EB !important;
          border-color: #1F2937 !important;
        }
        .leaflet-control-zoom a:hover {
          background: #1A2332 !important;
        }
      `}</style>
      <div ref={containerRef} className="w-full h-full" style={{ minHeight: 400 }} />
    </>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
