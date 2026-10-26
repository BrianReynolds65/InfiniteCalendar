FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY InfiniteCalendar.Api.csproj ./
RUN dotnet restore InfiniteCalendar.Api.csproj

COPY . ./
RUN dotnet publish InfiniteCalendar.Api.csproj \
    --configuration Release \
    --no-restore \
    --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080 \
    InfiniteCalendar__DataDirectory=/data
EXPOSE 8080

COPY --from=build /app/publish ./
RUN mkdir -p /data && chown 1654:1654 /data
USER 1654

ENTRYPOINT ["dotnet", "InfiniteCalendar.Api.dll"]
